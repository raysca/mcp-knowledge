# Document Knowledge MCP Service — Technical & Product Specification

**Status:** Draft v1  
**Runtime:** Bun  
**Primary language:** TypeScript  
**Primary interface:** MCP + HTTP API  
**Deployment modes:** Local / Server  
**Database:** libSQL/SQLite or PostgreSQL  
**ORM:** Drizzle ORM  
**Vector search:** libSQL vectors / pgvector  
**Object storage:** Local filesystem / S3-compatible storage  
**Embeddings:** `Xenova/all-MiniLM-L6-v2` (384-d, quantized ONNX, local)  
**Document parsing:** AnyDoc (`@firecrawl/anydoc`) behind a pluggable `DocumentParser` adapter  
**Tenancy:** Single-tenant instance (no workspaces)  
**UI:** React + shadcn/ui + Tailwind, served by the same Bun process (no Vite)

---

# 1. Overview

The project is a lightweight document knowledge service that turns uploaded documents into a persistent, queryable knowledge base for LLMs, agents, applications, and MCP clients.

The service accepts documents through an HTTP ingestion API and dashboard, parses and normalizes them, generates semantic chunks, creates local embeddings, indexes those chunks, and exposes retrieval capabilities through both HTTP and MCP.

The system is designed to work in two primary environments:

### Local mode

A zero-configuration deployment for developers, individuals, and small teams.

```text
Bun
├── libSQL / SQLite
├── local vector search
├── local filesystem
├── local embedding model
├── ingestion worker
├── dashboard
└── MCP server
```

### Server mode

A horizontally deployable infrastructure configuration.

```text
Bun instances
├── PostgreSQL
├── pgvector
├── S3-compatible object storage
├── local embedding workers
├── distributed job processing
├── dashboard
└── MCP over HTTP
```

The same application code must support both profiles.

---

# 2. Product goals

The project should provide:

1. Simple document ingestion.
2. Support for many document formats.
3. Local embeddings without requiring an external AI API.
4. High-quality semantic and lexical retrieval.
5. MCP-native access for models and agents.
6. A clean REST API for programmatic integrations.
7. A lightweight document administration dashboard.
8. Clear retrieval provenance and explainability.
9. Operational observability.
10. Easy local deployment.
11. Straightforward migration to production infrastructure.
12. Deterministic, reproducible indexing.
13. Extensible parsers, storage backends, databases, and embedding providers.
14. No required external LLM.

---

# 3. Non-goals

The project is not intended to become:

- a general-purpose AI chat application;
- an agent framework;
- an LLM hosting platform;
- a prompt-management application;
- a workflow automation product;
- a full enterprise content-management system;
- a document editor;
- a replacement for object storage;
- a generic vector-database abstraction.

A chat UI may eventually consume the API, but chat functionality does not belong in the core product.

The core concept is:

> Turn arbitrary documents into a queryable knowledge service for machines and humans.

---

# 4. Core design principles

## 4.1 MCP is an interface, not the architecture

MCP should be a thin adapter over application services.

```text
                   Core Services
                        ▲
             ┌──────────┼───────────┐
             │          │           │
             │          │           │
            MCP        HTTP        UI
```

MCP must not contain document parsing, database, chunking, or embedding logic.

---

## 4.2 Original files are canonical

Uploaded files are the source of truth.

Indexes, chunks, normalized representations, and embeddings must be considered rebuildable.

```text
Original document
        ↓
Normalized representation
        ↓
Chunks
        ↓
Embeddings
        ↓
Indexes
```

---

## 4.3 Infrastructure components are replaceable

Core business logic must depend on interfaces rather than implementations.

Examples:

```text
BlobStore
├── LocalBlobStore
└── S3BlobStore

KnowledgeRepository
├── LibSqlKnowledgeRepository
└── PostgresKnowledgeRepository

VectorIndex
├── LibSqlVectorIndex
└── PgVectorIndex

Embedder
├── LocalTransformersEmbedder
└── future external embedders
```

---

## 4.4 Zero external AI dependency

The default installation must be fully usable without:

- OpenAI;
- Anthropic;
- Cohere;
- Voyage;
- hosted embedding APIs;
- GPU infrastructure.

---

## 4.5 Retrieval should be inspectable

Users should be able to understand:

- which document matched;
- which chunk matched;
- where the chunk originated;
- semantic/vector ranking;
- lexical ranking;
- combined ranking;
- metadata filters applied;
- surrounding context;
- document and section hierarchy.

Retrieval must not behave as an opaque black box.

---

# 5. Proposed technology stack

## Runtime

```text
Bun
TypeScript
```

## Server

```text
Bun.serve()
```

One process serves:

```text
REST  /api/v1
MCP   /mcp
UI    /
health, ready, metrics
```

Do not add Express, Hono, Elysia, Next.js, or a second HTTP server. Routing stays in application code on `Bun.serve()`.

## Dashboard UI

```text
React
shadcn/ui
Tailwind CSS
```

The dashboard is a React SPA **bundled and served by Bun**, same origin as the API.

```text
allowed:    Bun.build / HTML imports / bun --hot
forbidden:  Vite, webpack, Next.js, a second package.json for the UI
```

shadcn components are copied into the server app (`src/ui/components`), not consumed as a runtime package. The UI calls `/api/v1` with relative URLs. No CORS for the dashboard.

## ORM

```text
Drizzle ORM
```

## Databases

```text
libSQL / SQLite
PostgreSQL
```

## Vector search

```text
libSQL native/vector extension
pgvector
```

## Object storage

```text
Bun file APIs
Bun S3 APIs
```

S3-compatible targets may include:

```text
AWS S3
Cloudflare R2
MinIO
Backblaze B2
other compatible services
```

## Local embeddings

```text
@huggingface/transformers
ONNX
```

The model should be bundled with the production image or optionally downloaded during installation/build.

## Parsing

Document parsing must use a pluggable adapter.

Default v1 adapter:

```text
AnyDoc (@firecrawl/anydoc)
```

AnyDoc is a local Rust converter (Firecrawl) with Node/N-API bindings. It detects format from file bytes, produces a shared document model, and does not require Python, LibreOffice, or a hosted API.

The application must not import AnyDoc types outside `packages/parser`. Core ingestion depends only on `DocumentParser` and `NormalizedDocument`.

First-party passthrough adapters cover formats AnyDoc does not (plain text, Markdown, HTML, JSON, XML).

Hosted OCR (`ocr: "hosted"` → Firecrawl Parse) is **disabled by default**. It would violate the zero-external-AI rule. Scanned PDFs fail with `NeedsOcr` and a user-visible error.

---

# 6. Repository structure

Recommended monorepo:

```text
/
├── apps/
│   └── server/
│       ├── src/
│       │   ├── index.ts
│       │   ├── http/
│       │   ├── mcp/
│       │   ├── workers/
│       │   ├── config/
│       │   └── ui/
│       │       ├── index.html
│       │       ├── main.tsx
│       │       ├── app.tsx
│       │       ├── styles.css
│       │       ├── components/    # shadcn
│       │       └── pages/
│       ├── components.json
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── core/
│   │   ├── documents/
│   │   ├── ingestion/
│   │   ├── retrieval/
│   │   ├── collections/
│   │   ├── jobs/
│   │   └── shared/
│   │
│   ├── db/
│   │   ├── schema/
│   │   ├── libsql/
│   │   └── postgres/
│   │
│   ├── parser/
│   │   ├── interfaces/
│   │   ├── adapters/
│   │   │   ├── anydoc/
│   │   │   └── native-text/
│   │   └── normalize/
│   │
│   ├── embeddings/
│   │   ├── interfaces/
│   │   ├── local/
│   │   └── models/
│   │
│   ├── storage/
│   │   ├── interfaces/
│   │   ├── local/
│   │   └── s3/
│   │
│   ├── retrieval/
│   │   ├── vector/
│   │   ├── lexical/
│   │   ├── hybrid/
│   │   └── ranking/
│   │
│   └── sdk/
│       └── TypeScript client
│
├── drizzle/
├── models/
├── docs/
├── package.json
└── bun.lock
```

---

# 7. Domain model

Primary entities:

```text
ApiKey
Collection
Document
DocumentRevision
DocumentChunk
IngestionJob
Webhook
WebhookDelivery
```

v1 is a single-tenant instance. There is no workspace entity and no `workspaceId` column.

---

# 8. Tenancy

v1 does not implement workspaces, organizations, or tenants.

The running process owns one document corpus. API keys, collections, documents, jobs, and webhooks are instance-scoped. The HTTP API has no workspace path segment or workspace header.

Multi-tenant workspaces are deferred. Do not insert a dummy `default` workspace row.

---

# 9. Collections

Collections provide logical knowledge boundaries.

Examples:

```text
Engineering Docs
Customer Contracts
Product Documentation
Research
Company Handbook
```

```ts
interface Collection {
  id: string;

  name: string;
  description?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

A document may initially belong to one collection.

Future support for many-to-many document collections may be added later if required.

---

# 10. Document model

```ts
interface Document {
  id: string;
  collectionId?: string;

  currentRevisionId?: string;

  title?: string;

  originalFilename: string;
  mimeType: string;
  extension?: string;

  sizeBytes: number;
  sha256: string;

  status:
    | "pending"
    | "processing"
    | "ready"
    | "failed"
    | "deleting"
    | "deleted";

  metadata: Record<string, unknown>;

  latestError?: string;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}
```

---

# 11. Document revisions

Updating a document should create a new revision rather than mutating the old representation.

```ts
interface DocumentRevision {
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
}
```

This makes reindexing and history explicit.

---

# 12. Normalized document representation

Every parser must produce the same internal representation.

```ts
interface NormalizedDocument {
  title?: string;

  metadata: Record<string, unknown>;

  blocks: DocumentBlock[];
}
```

Supported block types:

```ts
type DocumentBlock =
  | HeadingBlock
  | ParagraphBlock
  | TableBlock
  | CodeBlock
  | ListBlock
  | QuoteBlock
  | ImageBlock
  | PageBreakBlock;
```

Example:

```ts
interface HeadingBlock {
  type: "heading";

  level: number;
  text: string;

  location?: SourceLocation;
}
```

---

# 13. Source location

Every block and chunk should preserve provenance.

```ts
interface SourceLocation {
  pageStart?: number;
  pageEnd?: number;

  slide?: number;

  sheet?: string;
  cellRange?: string;

  section?: string;

  charStart?: number;
  charEnd?: number;

  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
```

Not every parser must populate every field.

---

# 14. Supported document formats

The parser architecture must support arbitrary formats through adapters.

v1 formats via AnyDoc:

```text
PDF (text-based, via pdf-inspector inside AnyDoc)
Word (.doc, .docx, .docm)
PowerPoint (.ppt, .pps, .pot, .pptx, .pptm, .ppsx, .ppsm)
Excel (.xls, .xlsx, .xlsm, .xlsb)
OpenDocument (.odt, .ods, .odp)
RTF
EPUB
CSV
```

v1 formats via first-party native-text adapters (not AnyDoc):

```text
TXT
Markdown
HTML
JSON
XML
```

Out of v1:

```text
scanned / image-only PDFs (AnyDoc error code needsOcr)
raster images (PNG, JPEG, TIFF) — no local OCR
password-protected / encrypted files
```

Additional formats should not require changes to the ingestion pipeline.

---

# 15. Parser interface

```ts
interface DocumentParser {
  name: string;
  version: string;

  supports(input: {
    mimeType?: string;
    extension?: string;
  }): boolean;

  parse(input: {
    data: Blob;
    filename: string;
    mimeType?: string;
  }): Promise<NormalizedDocument>;
}
```

Parser selection must be handled through a registry.

```ts
parserRegistry.find({
  mimeType,
  extension
});
```

The registry should also accept a content-sniffed format when the adapter provides one. AnyDoc exposes `formatFromBytes`; CSV has no magic bytes and still needs filename/extension.

## 15.1 Default adapter: AnyDoc

Package: `@firecrawl/anydoc`.

Workers must call the structured document API, not Markdown-only conversion:

```ts
toDocument(bytes) / toDocumentBytes(bytes, format?)
```

Markdown (`toMarkdownBytes`) may be stored as an optional human-readable `normalized.md` sidecar. Canonical normalized storage is `NormalizedDocument` JSON produced by our mapper.

Mapping rules:

```text
AnyDoc Document.blocks  →  NormalizedDocument.blocks
headings                →  HeadingBlock
paragraphs / quotes     →  ParagraphBlock / QuoteBlock
lists                   →  ListBlock
tables (incl. merged)   →  TableBlock (structure preserved, not flattened)
code                    →  CodeBlock
images                  →  ImageBlock (alt text in content; bytes stay in blob store if retained)
```

AnyDoc types must not leak past `packages/parser/adapters/anydoc`.

Parser identity written on each revision:

```text
parserName: "anydoc"
parserVersion: <package version>
```

## 15.2 Error mapping

AnyDoc `error.code` maps to ingestion failure, never a silent empty document:

```text
unsupported     →  DOCUMENT_UNSUPPORTED_FORMAT
needsOcr        →  DOCUMENT_NEEDS_OCR
malformed       →  DOCUMENT_MALFORMED
encrypted       →  DOCUMENT_ENCRYPTED
resourceLimit   →  DOCUMENT_RESOURCE_LIMIT
missingPart     →  DOCUMENT_MALFORMED
hosted          →  must not occur (hosted OCR disabled)
```

`DOCUMENT_NEEDS_OCR` is a terminal v1 failure with a dashboard message that scanned pages are not supported without an OCR provider.

## 15.3 Runtime and packaging

`@firecrawl/anydoc` is an N-API native addon. v1 must:

```text
verify it loads under Bun (spike before Phase 2)
ship the correct platform binary in the Docker image
run conversion on the worker, never on the HTTP request path
enforce parser timeout and resource limits around the call
```

If N-API is unusable on Bun, fall back to `@firecrawl/anydoc-wasm` in the worker. Do not call Firecrawl Parse.

Do not enable `ocr: "hosted"` in the default profile.

---

# 16. Ingestion lifecycle

```text
upload
  ↓
validate
  ↓
store original
  ↓
create document/revision
  ↓
enqueue ingestion job
  ↓
parse
  ↓
normalize
  ↓
store normalized representation
  ↓
chunk
  ↓
embed
  ↓
write chunks
  ↓
build vector index
  ↓
build lexical index
  ↓
mark document ready
  ↓
emit webhook
```

---

# 17. Ingestion status

Document status:

```text
pending
processing
ready
failed
deleting
deleted
```

Job status:

```text
queued
running
completed
failed
retrying
cancelled
```

---

# 18. Ingestion job model

```ts
interface IngestionJob {
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
}
```

---

# 19. Job processing

v1 should use the database as the durable queue.

No Redis dependency is required.

Workers should claim jobs atomically. Lease: 5 minutes (`JOB_LEASE_MS=300000`). A `running` job whose `locked_at` is older than the lease is reclaimable.

Postgres:

```sql
UPDATE ingestion_jobs
SET
  status = 'running',
  locked_by = $worker_id,
  locked_at = now(),
  started_at = COALESCE(started_at, now()),
  attempt = attempt + 1,
  updated_at = now()
WHERE id = (
  SELECT id FROM ingestion_jobs
  WHERE status IN ('queued', 'retrying')
     OR (status = 'running' AND locked_at < now() - interval '5 minutes')
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

libSQL (serialize writers with `BEGIN IMMEDIATE`):

```sql
UPDATE ingestion_jobs
SET
  status = 'running',
  locked_by = ?,
  locked_at = ?,
  started_at = COALESCE(started_at, ?),
  attempt = attempt + 1,
  updated_at = ?
WHERE id = (
  SELECT id FROM ingestion_jobs
  WHERE status IN ('queued', 'retrying')
     OR (status = 'running' AND locked_at < ?)
  ORDER BY created_at
  LIMIT 1
)
AND status IN ('queued', 'retrying', 'running');
```

If the UPDATE affects 0 rows, there is no work. Crash mid-job: lease expiry plus `attempt < max_attempts` retries; otherwise `failed`.

The abstraction should remain:

```ts
interface JobRepository {
  enqueue(...): Promise<IngestionJob>;
  claim(workerId: string): Promise<IngestionJob | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: Error): Promise<void>;
}
```

---

# 20. Worker model

In local mode:

```text
server process
+
embedded worker loop
```

In server mode:

```text
web process × N

worker process × N
```

Workers must remain stateless when server mode uses Postgres and S3.

---

# 21. Chunking

Chunks should prioritize semantic structure over fixed token boundaries.

Token counts use the embedding model tokenizer (WordPiece for `all-MiniLM-L6-v2`).

Target defaults, sized for the model’s 256-token input limit (heading-path prefix consumes part of that budget):

```text
target: 180 tokens
minimum: 64 tokens
maximum: 220 tokens
overlap: 32 tokens
```

These must be configurable, but `maximum` plus the embedding prefix must not exceed `EMBEDDING_MAX_TOKENS` (256). Truncate the chunk body, never the heading prefix, if a leftover still overflows.

Chunk boundaries should prefer:

1. heading hierarchy;
2. paragraph boundaries;
3. table boundaries;
4. list boundaries;
5. sentence boundaries;
6. token boundaries.

---

# 22. Chunk model

```ts
interface DocumentChunk {
  id: string;

  collectionId?: string;

  documentId: string;
  revisionId: string;

  sequence: number;

  content: string;

  embeddingText: string;

  headingPath: string[];

  location?: SourceLocation;

  tokenCount: number;

  metadata: Record<string, unknown>;

  contentHash: string;

  createdAt: Date;
}
```

---

# 23. Embedding input

Embedding input should contain contextual information.

Instead of:

```text
Revenue grew 15% this quarter.
```

embed:

```text
Document: FY2026 Q3 Results
Section: Financial Results > Revenue

Revenue grew 15% this quarter.
```

The stored visible chunk content should remain clean source text.

---

# 24. Deterministic chunk IDs

Chunk identity should be deterministic.

Recommended source:

```text
hash(
  revision/source hash
  +
  heading path
  +
  normalized chunk text
)
```

Deterministic IDs enable incremental reindexing.

---

# 25. Incremental indexing

When a revision is uploaded:

```text
old chunks
vs
new chunks
```

categorize:

```text
unchanged
changed
added
removed
```

Only changed and new chunks should require embedding.

Removed chunks should be deleted from indexes.

This functionality may be v1.5, but the schema must allow it from v1.

---

# 26. Embedding interface

```ts
interface Embedder {
  name: string;
  model: string;
  version: string;
  dimensions: number;

  embed(
    texts: string[]
  ): Promise<number[][]>;
}
```

---

# 27. Default embedding provider

Default:

```text
@huggingface/transformers
ONNX Runtime (CPU)
Xenova/all-MiniLM-L6-v2
```

Pinned configuration:

```text
model id:       Xenova/all-MiniLM-L6-v2
file:           onnx/model_uint8.onnx  (~23 MB)
dimensions:     384
metric:         cosine (normalize: true, pooling: mean)
max tokens:     256
language:       English
tokenizer:      the model’s WordPiece tokenizer
remote download at runtime: disabled
```

This is the smallest commonly used Transformers.js embedding model. Chunk defaults in §21 exist because this model truncates at 256 tokens — not because 180-token chunks are independently optimal.

Requirements:

- CPU compatible;
- no Python dependency;
- no internet required at runtime (`env.allowRemoteModels = false`);
- normalized embeddings;
- batch inference;
- deterministic model configuration.

---

# 28. Embedding model packaging

Production images should include the default model.

Example:

```text
/models/default/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    └── model_uint8.onnx
```

Vendored from `Xenova/all-MiniLM-L6-v2`. Default runtime must disable remote model downloads.

```env
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=all-minilm-l6-v2
EMBEDDING_MODEL_PATH=./models/default
EMBEDDING_DIMENSIONS=384
EMBEDDING_MAX_TOKENS=256
EMBEDDING_BATCH_SIZE=32
```

Optional configuration may point `EMBEDDING_MODEL_PATH` at a different local snapshot. Changing model or dimensions requires a full reindex.

---

# 29. Embedding model lifecycle

The embedding model should load once per worker.

```text
worker starts
  ↓
load model
  ↓
reuse pipeline
  ↓
batch embedding requests
```

Do not load the model per document or per HTTP request.

---

# 30. Embedding batching

Configurable:

```env
EMBEDDING_BATCH_SIZE=32
```

Workers should batch chunk embedding requests.

---

# 31. Database layer

Use Drizzle for:

- schemas;
- migrations;
- CRUD;
- metadata queries;
- transactions.

Database-specific search functionality may use raw SQL where needed.

The application must not pretend pgvector and libSQL vector operations are identical.

---

# 32. Database abstraction

```ts
interface KnowledgeRepository {
  createDocument(...): Promise<Document>;

  getDocument(...): Promise<Document | null>;

  listDocuments(...): Promise<Paginated<Document>>;

  createRevision(...): Promise<DocumentRevision>;

  insertChunks(...): Promise<void>;

  getChunk(...): Promise<DocumentChunk | null>;

  getChunkNeighbors(...): Promise<DocumentChunk[]>;

  deleteRevision(...): Promise<void>;

  softDeleteDocument(...): Promise<void>;

  finalizeDeleteDocument(...): Promise<void>;

  updateDocumentStatus(...): Promise<void>;
}
```

Implementations:

```text
LibSqlKnowledgeRepository
PostgresKnowledgeRepository
```

---

# 33. Vector abstraction

```ts
interface VectorIndex {
  insert(chunks: EmbeddedChunk[]): Promise<void>;

  search(input: {
    collectionIds?: string[];
    documentIds?: string[];
    vector: number[];
    limit: number;
  }): Promise<VectorHit[]>;

  deleteRevision(revisionId: string): Promise<void>;
}
```

Implementations:

```text
LibSqlVectorIndex
PgVectorIndex
```

---

# 34. Lexical search

The retrieval engine must support keyword/full-text search.

This is important for queries containing:

```text
invoice IDs
contract numbers
SKUs
product codes
names
error codes
exact phrases
```

v1 engines (do not invent a third):

```text
libSQL / SQLite  →  FTS5 virtual table document_chunks_fts
Postgres         →  tsvector + GIN on document_chunks.search_tsv
```

Tokenizer: `unicode61` (FTS5) and Postgres `simple`. Do **not** use Porter / `english` stemming. Stemming destroys SKUs and error codes.

Indexed fields:

```text
content        (weight A)
heading_path   (weight B, joined with spaces)
```

Query: the user’s raw query string, with FTS5 `"` wrapping when the client asks for an exact phrase. Default is an AND of tokens (FTS5) / `plainto_tsquery('simple', query)` (Postgres).

Keep FTS in sync with chunk rows via SQL triggers (libSQL) or a generated stored column (Postgres). Rebuild FTS on reindex.

Candidate counts before fusion (hybrid):

```env
VECTOR_CANDIDATES=50
LEXICAL_CANDIDATES=50
RRF_K=60
```

Each side retrieves its candidate pool (filtered by collection/document/metadata). RRF fuses those lists, then the service cuts to `limit` (default 8). `k = 60` is the RRF constant, not the candidate pool size.

---

# 35. Hybrid retrieval

Default retrieval mode:

```text
hybrid
```

Supported modes:

```text
vector
lexical
hybrid
```

Hybrid process:

```text
query
  ├── vector retrieval
  └── lexical retrieval
          ↓
        fusion
          ↓
       top results
```

---

# 36. Rank fusion

Initial implementation should use Reciprocal Rank Fusion.

```text
RRF(document) =
Σ 1 / (k + rank)
```

Default:

```text
k = 60
```

This avoids attempting to normalize incompatible database-specific score ranges.

---

# 37. Optional reranking

Reranking should not be required for v1.

The retrieval pipeline should expose an interface allowing future rerankers.

```ts
interface Reranker {
  rerank(
    query: string,
    hits: SearchHit[]
  ): Promise<SearchHit[]>;
}
```

---

# 38. Search result model

```ts
interface SearchHit {
  chunkId: string;

  documentId: string;
  revisionId: string;

  title?: string;

  content: string;

  headingPath: string[];

  location?: SourceLocation;

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
}
```

---

# 39. Retrieval explainability

Every search may optionally return explanation information.

Example:

```json
{
  "finalRank": 1,
  "vectorRank": 2,
  "lexicalRank": 1,
  "fusionScore": 0.0325,
  "matchedTerms": [
    "termination",
    "notice"
  ]
}
```

Normal MCP search responses should remain concise.

The playground and diagnostic API may expose the full explanation.

---

# 40. Context expansion

Search should initially return focused chunks.

Clients may request surrounding context.

Supported expansion modes:

```text
none
neighbors
section
document
```

Example:

```json
{
  "expand": {
    "type": "neighbors",
    "before": 2,
    "after": 2
  }
}
```

---

# 41. Neighbor retrieval

```ts
getChunkContext({
  chunkId,
  before: 2,
  after: 2
});
```

Response:

```text
chunk N-2
chunk N-1
matched chunk
chunk N+1
chunk N+2
```

---

# 42. Parent section expansion

The chunker should preserve heading hierarchy.

A client may request all chunks sharing a semantic parent heading.

Example:

```text
Contract
  > Termination
      chunk 40
      chunk 41
      chunk 42
```

A match on chunk 41 may expand to the complete `Termination` section.

---

# 43. Object storage

```ts
interface BlobStore {
  put(
    key: string,
    data: Blob
  ): Promise<void>;

  get(
    key: string
  ): Promise<Blob>;

  delete(
    key: string
  ): Promise<void>;

  exists(
    key: string
  ): Promise<boolean>;
}
```

Implementations:

```text
LocalBlobStore
S3BlobStore
```

---

# 44. Storage keys

Recommended layout:

```text
documents/{documentId}/
  revisions/{revisionId}/
    original
    normalized.json
    normalized.md
```

Avoid relying on original filenames as storage identifiers.

---

# 45. Normalized representation storage

Normalized parser output should optionally be persisted.

Benefits:

- faster re-chunking;
- parser-independent debugging;
- easier document inspection;
- cheaper embedding-model migrations.

Default:

```text
normalized.json
```

Potential secondary human-readable representation:

```text
normalized.md
```

---

# 46. HTTP API

Base:

```text
/api/v1
```

---

# 47. Document upload

```http
POST /api/v1/documents
Content-Type: multipart/form-data
```

Fields:

```text
file
collectionId?
metadata?
```

Response:

```json
{
  "id": "doc_...",
  "status": "pending",
  "revision": 1
}
```

HTTP:

```text
202 Accepted
```

---

# 48. Remote ingestion API

Documents should also be ingestible without manually uploading bytes.

```http
POST /api/v1/documents/from-url
```

Request:

```json
{
  "url": "https://example.com/report.pdf",
  "collectionId": "col_...",
  "metadata": {}
}
```

The server fetches and stores the object before ingestion.

Security restrictions must apply.

See SSRF protections later in this document.

---

# 49. S3/object ingestion

Server deployments should support ingestion from an existing object.

```http
POST /api/v1/documents/from-object
```

Example:

```json
{
  "bucket": "uploads",
  "key": "reports/report.pdf",
  "collectionId": "col_..."
}
```

This endpoint should initially be disabled unless explicitly configured.

---

# 50. List documents

```http
GET /api/v1/documents
```

Parameters:

```text
collectionId
status
search
limit
cursor
sort
```

---

# 51. Get document

```http
GET /api/v1/documents/:documentId
```

---

# 52. Delete document

```http
DELETE /api/v1/documents/:documentId
```

Default behavior:

```text
soft delete
↓
enqueue cleanup
↓
delete chunks
↓
delete vectors
↓
delete normalized representation
↓
delete original blob
↓
finalize deletion
```

---

# 53. Replace/update document

```http
POST /api/v1/documents/:documentId/revisions
```

Creates a new revision.

Existing revision remains available until cleanup/history policy removes it.

---

# 54. Reindex document

```http
POST /api/v1/documents/:documentId/reindex
```

Optional parameters:

```json
{
  "parser": false,
  "chunker": true,
  "embeddings": true
}
```

---

# 55. Download original

```http
GET /api/v1/documents/:documentId/file
```

---

# 56. Normalized representation

```http
GET /api/v1/documents/:documentId/normalized
```

---

# 57. Document chunks

```http
GET /api/v1/documents/:documentId/chunks
```

Supports pagination.

---

# 58. Search API

```http
POST /api/v1/search
```

Request:

```json
{
  "query": "What are the cancellation terms?",

  "collectionIds": [],
  "documentIds": [],

  "filters": {},

  "mode": "hybrid",

  "limit": 8,

  "expand": {
    "type": "none"
  },

  "explain": false
}
```

---

# 59. Explain search API

```http
POST /api/v1/search/explain
```

Same search input.

Response includes:

- vector results;
- lexical results;
- fusion result;
- ranks;
- scores;
- filters;
- timing information;
- chunk metadata.

This powers the retrieval playground.

---

# 60. Chunk API

```http
GET /api/v1/chunks/:chunkId
```

Optional:

```text
?before=2&after=2
```

---

# 61. Collections API

```http
POST   /api/v1/collections
GET    /api/v1/collections
GET    /api/v1/collections/:id
PATCH  /api/v1/collections/:id
DELETE /api/v1/collections/:id
```

Deleting a collection should require explicit handling of its documents.

Initial behavior:

```text
reject deletion while documents remain
```

---

# 62. MCP server

Primary hosted endpoint:

```text
/mcp
```

Transport:

```text
Streamable HTTP
```

Optional local CLI mode:

```text
stdio
```

---

# 63. MCP authentication

Hosted MCP must use the same API keys as the REST API.

No unauthenticated remote MCP by default.

---

# 64. MCP tools

v1 tools:

```text
search_documents
get_document
get_chunk
list_documents
list_collections
```

Optional diagnostic tool:

```text
explain_search
```

`explain_search` may be disabled by default in hosted environments.

---

# 65. `search_documents`

Input:

```json
{
  "query": "termination without cause",

  "collection_ids": [],
  "document_ids": [],

  "filters": {},

  "limit": 8,

  "mode": "hybrid",

  "expand": {
    "type": "none"
  }
}
```

Output should include:

```text
chunk ID
document ID
document title
content
heading path
source location
rank
resource URI
```

---

# 66. `get_document`

Input:

```json
{
  "document_id": "doc_..."
}
```

Returns:

- metadata;
- current revision;
- normalized representation or a suitable bounded portion;
- source resource URI.

Large documents must not be returned in full. If normalized text exceeds **32,000 characters** (`MAX_MCP_DOCUMENT_CHARS=32000`), return metadata plus a truncated body and instruct the client to use `search_documents` / `get_chunk`.

---

# 67. `get_chunk`

Input:

```json
{
  "chunk_id": "chunk_...",
  "before": 1,
  "after": 1
}
```

---

# 68. `list_documents`

Input:

```json
{
  "collection_id": "col_...",
  "limit": 50
}
```

---

# 69. `list_collections`

Returns all collections on the instance.

---

# 70. MCP resources

Recommended resource scheme:

```text
document://{documentId}

document://{documentId}/revisions/{revisionId}

document://{documentId}/chunks/{chunkId}

document://{documentId}/normalized
```

---

# 71. Administrative MCP actions

Deletion, uploads, webhook changes, and administrative settings should not be exposed to general-purpose MCP clients by default.

If administrative MCP functionality is later added, it must be controlled separately.

---

# 72. Dashboard

The dashboard is a React SPA using shadcn/ui and Tailwind CSS, served by the same `Bun.serve()` process as the API.

```text
same origin
same process
no Vite
no separate dashboard package
```

`bun dev` and the production binary both serve UI + API. The client is bundled with Bun (`Bun.build` or HTML imports). There is no `vite.config`, no second port, and no `apps/dashboard` workspace.

Primary areas:

```text
Documents
Collections
Playground
Jobs
Webhooks
System
```

---

# 73. Dashboard — documents

Features:

- upload documents;
- drag/drop;
- list documents;
- filter by collection;
- filter by status;
- view ingestion progress;
- inspect metadata;
- replace document;
- reindex;
- download original;
- delete.

Example:

```text
Documents

[ Upload ]

Filename           Status       Chunks    Collection
----------------------------------------------------
contract.pdf       Ready        82        Legal
handbook.docx      Processing   —         HR
pricing.xlsx       Ready        134       Sales
```

---

# 74. Dashboard — document detail

Display:

```text
filename
title
status
collection
size
hash
created date
current revision
parser/version
chunker/version
embedding model
dimensions
chunk count
metadata
```

Actions:

```text
Download original
View normalized
View chunks
Replace
Reindex
Delete
```

---

# 75. Retrieval playground

The retrieval playground is a first-class differentiating feature.

Users can enter a query and inspect exactly what the retrieval engine sees.

Inputs:

```text
query

collection filter
document filter
metadata filters

search mode:
  hybrid
  vector
  lexical

result limit

context expansion

explain toggle
```

---

# 76. Playground result

Example:

```text
Query
"What are the cancellation terms?"

Result #1

Document
Customer Agreement.pdf

Section
Terms > Termination

Pages
14–15

Final rank
#1

Vector rank
#2

Lexical rank
#1

Fusion score
0.0325

Matched lexical terms
termination
cancel
notice

Chunk
--------------------------------
Either party may terminate...
--------------------------------

[ Previous ]
[ Next ]
[ Expand section ]
[ Open document ]
```

---

# 77. Playground comparison mode

A useful v1.5 feature:

Allow side-by-side retrieval settings.

Example:

```text
Hybrid search
vs
Vector-only
```

This should not block v1.

---

# 78. Observability

The service must expose operational information without requiring an external observability stack.

Built-in observability should include:

```text
health
metrics
job state
search timing
ingestion timing
embedding throughput
parser errors
storage errors
webhook failures
```

---

# 79. Health endpoint

```http
GET /health
```

Simple liveness.

---

# 80. Readiness endpoint

```http
GET /ready
```

Checks:

```text
database reachable
storage reachable
embedding model loaded/available
worker state
migrations applied
```

---

# 81. System status endpoint

```http
GET /api/v1/system/status
```

Example:

```json
{
  "database": {
    "driver": "postgres",
    "healthy": true
  },

  "storage": {
    "driver": "s3",
    "healthy": true
  },

  "embedding": {
    "provider": "local",
    "model": "...",
    "dimensions": 384,
    "healthy": true
  },

  "workers": {
    "active": 3
  }
}
```

---

# 82. Metrics

Expose:

```text
/metrics
```

Prometheus-compatible metrics are desirable.

Metrics should include:

```text
documents_total

documents_processing

documents_failed_total

ingestion_duration_seconds

parser_duration_seconds

chunking_duration_seconds

embedding_duration_seconds

embedding_chunks_total

embedding_chunks_per_second

search_duration_seconds

search_requests_total

vector_search_duration_seconds

lexical_search_duration_seconds

storage_operations_total

webhook_delivery_total

webhook_delivery_failures_total

job_queue_depth
```

---

# 83. Structured logging

Logs should be structured JSON in production.

Fields:

```text
timestamp
level
requestId
documentId
revisionId
revisionId
jobId
operation
durationMs
error
```

Never log:

- document content;
- embeddings;
- secrets;
- authorization headers.

---

# 84. Request IDs

Every HTTP request should have:

```text
requestId
```

Read from an incoming header if present or generate one.

Return it in responses.

Use the same request ID in logs.

---

# 85. Search traces

Explain mode may expose search timing:

```json
{
  "timing": {
    "embeddingMs": 14,
    "vectorSearchMs": 7,
    "lexicalSearchMs": 4,
    "fusionMs": 1,
    "totalMs": 28
  }
}
```

---

# 86. Webhooks

Users may configure instance-level webhooks.

Initial events:

```text
document.created

document.processing

document.ready

document.failed

document.deleted

document.reindexed

job.failed
```

---

# 87. Webhook model

```ts
interface Webhook {
  id: string;

  url: string;

  events: string[];

  secret: string;

  enabled: boolean;

  createdAt: Date;
  updatedAt: Date;
}
```

---

# 88. Webhook payload

Example:

```json
{
  "id": "evt_...",
  "type": "document.ready",
  "timestamp": "2026-08-29T12:00:00Z",

  "data": {
    "documentId": "doc_...",
    "revisionId": "rev_...",
    "chunkCount": 83
  }
}
```

---

# 89. Webhook signing

Webhook requests must be signed.

Recommended:

```text
HMAC-SHA256
```

Headers:

```text
X-Webhook-ID
X-Webhook-Timestamp
X-Webhook-Signature
```

---

# 90. Webhook delivery

Requirements:

```text
timeouts: 10 s (WEBHOOK_TIMEOUT_MS=10000)
retry policy
exponential backoff
delivery history
manual retry
```

Suggested retry:

```text
1 minute
5 minutes
30 minutes
2 hours
12 hours
```

---

# 91. Webhook API

```http
POST   /api/v1/webhooks
GET    /api/v1/webhooks
GET    /api/v1/webhooks/:id
PATCH  /api/v1/webhooks/:id
DELETE /api/v1/webhooks/:id

GET    /api/v1/webhooks/:id/deliveries

POST   /api/v1/webhooks/:id/test
```

---

# 92. Metadata

Users may attach arbitrary metadata to documents.

Example:

```json
{
  "customer": "Acme",
  "department": "legal",
  "year": 2026,
  "region": "UK"
}
```

Metadata should be preserved on chunks where appropriate.

---

# 93. Metadata filters

Search API should support:

```json
{
  "filters": {
    "department": "legal",
    "year": {
      "gte": 2025
    }
  }
}
```

v1 filter operators:

```text
eq
neq
in
exists
gte
lte
```

---

# 94. Configuration

Configuration should use environment variables.

Example local:

```env
APP_PROFILE=local

DATABASE_DRIVER=libsql
DATABASE_URL=file:./data/app.db

STORAGE_DRIVER=local
STORAGE_PATH=./data/documents

EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=all-minilm-l6-v2
EMBEDDING_MODEL_PATH=./models/default
EMBEDDING_DIMENSIONS=384
EMBEDDING_MAX_TOKENS=256
EMBEDDING_BATCH_SIZE=32

VECTOR_CANDIDATES=50
LEXICAL_CANDIDATES=50
RRF_K=60

JOB_LEASE_MS=300000
WORKER_CONCURRENCY=1

MAX_UPLOAD_BYTES=67108864
MAX_EXTRACT_BYTES=8388608
MAX_DOCUMENT_PAGES=500
MAX_SPREADSHEET_CELLS=200000
PARSER_TIMEOUT_MS=30000
INGESTION_TIMEOUT_MS=600000
```

Example server:

```env
APP_PROFILE=server

DATABASE_DRIVER=postgres
DATABASE_URL=postgresql://...

STORAGE_DRIVER=s3

S3_BUCKET=documents
S3_ENDPOINT=https://...
S3_REGION=auto

EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=all-minilm-l6-v2
EMBEDDING_MODEL_PATH=/app/models/default
EMBEDDING_DIMENSIONS=384

WORKER_CONCURRENCY=4
```

---

# 95. Profiles

`APP_PROFILE=local`

defaults:

```text
libSQL
local storage
embedded worker
local embeddings
```

`APP_PROFILE=server`

defaults:

```text
Postgres
S3
distributed-safe jobs
local embeddings
```

Profiles provide defaults only.

Individual components remain configurable.

---

# 96. Authentication

Local mode may optionally support no authentication when explicitly bound to localhost.

Remote/server mode must require authentication.

Initial authentication may use API keys.

```text
Authorization: Bearer <key>
```

API keys belong to the instance. Store only a SHA-256 hash; show the secret once at creation.

```ts
interface ApiKey {
  id: string;
  name: string;

  keyPrefix: string;
  keyHash: string;

  scopes: string[];

  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}
```

---

# 97. API key permissions

Initial scopes:

```text
documents:read
documents:write
documents:delete

search:read

collections:read
collections:write

webhooks:read
webhooks:write

admin
```

MCP tokens should generally have:

```text
documents:read
search:read
collections:read
```

---

# 98. Security — uploaded documents

Uploaded documents are untrusted. v1 defaults (overridable via env, not higher in code without an explicit config change):

```env
MAX_UPLOAD_BYTES=67108864
MAX_EXTRACT_BYTES=8388608
MAX_DOCUMENT_PAGES=500
MAX_SPREADSHEET_CELLS=200000
MAX_ARCHIVE_UNCOMPRESSED_BYTES=104857600
MAX_ARCHIVE_ENTRIES=1024
MAX_ARCHIVE_COMPRESSION_RATIO=100
PARSER_TIMEOUT_MS=30000
INGESTION_TIMEOUT_MS=600000
MAX_CHUNKS_PER_DOCUMENT=20000
```

| Limit | Default | Meaning |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | 64 MiB | Multipart body and stored original |
| `MAX_EXTRACT_BYTES` | 8 MiB | Unicode text after parse, before chunking |
| `MAX_DOCUMENT_PAGES` | 500 | PDF / PPT / EPUB pages |
| `MAX_SPREADSHEET_CELLS` | 200,000 | xls/xlsx/csv rows×columns populated |
| `MAX_ARCHIVE_UNCOMPRESSED_BYTES` | 100 MiB | EPUB/OOXML zip expansion |
| `MAX_ARCHIVE_ENTRIES` | 1,024 | Files inside a package |
| `MAX_ARCHIVE_COMPRESSION_RATIO` | 100 | Zip-bomb guard (uncompressed / compressed) |
| `PARSER_TIMEOUT_MS` | 30 s | Wall time for `DocumentParser.parse` |
| `INGESTION_TIMEOUT_MS` | 10 min | Whole job (parse + chunk + embed + index) |
| `MAX_CHUNKS_PER_DOCUMENT` | 20,000 | Hard stop after chunking |

HTTP upload over `MAX_UPLOAD_BYTES` returns **413**. Parser/extract/page/cell/archive/timeout failures fail the job with `DOCUMENT_RESOURCE_LIMIT` (or `PARSER_TIMEOUT` when the timer fires). Do not store a partial index for that revision.

v1 upload accepts **one file per request**.

---

# 99. Parser isolation

Parser execution should be architecturally isolated from request handling.

v1 may execute in the same runtime.

The design must allow parsers to move to:

```text
dedicated process
container
sandbox
```

without changing the API.

---

# 100. Remote URL ingestion security

Remote ingestion introduces SSRF risk.

The fetcher must block:

```text
localhost
127.0.0.0/8
::1
RFC1918 private networks
link-local addresses
cloud metadata addresses
```

unless explicitly configured otherwise.

Redirects must be revalidated. At most **3** redirects (`URL_FETCH_MAX_REDIRECTS=3`).

URL fetch uses the same size cap as upload (`MAX_UPLOAD_BYTES`) and **30 s** (`URL_FETCH_TIMEOUT_MS=30000`). The download is streamed to storage; do not buffer the whole object in memory.

---

# 101. MIME validation

Do not trust only:

```text
filename extension
client Content-Type
```

Use content sniffing where practical.

AnyDoc already detects format from bytes (PDF header, RTF, OLE, ZIP mimetype). The upload path should still sniff independently for allowlisting before the file is stored. CSV has no magic bytes and requires extension or an explicit format hint.

---

# 102. Document deletion

Deletion must remove:

```text
database metadata
chunks
vector entries
lexical index entries
normalized data
original object
pending jobs
```

Prefer:

```text
soft delete
+
asynchronous physical cleanup
```

for reliability.

---

# 103. Duplicate detection

Use SHA-256 of original content.

If a non-deleted document already has that hash, do not create a second document. Return the existing document with `duplicate: true`. To replace bytes, POST a new revision on that document.

---

# 104. Reindex detection

A document should be marked as potentially stale when any of these change:

```text
parser version
chunker version
embedding model
embedding version
embedding dimensions
```

Dashboard example:

```text
Reindex recommended

Reason:
Chunker semantic-v2 → semantic-v3
```

---

# 105. Index configuration model

Store the active indexing configuration.

```ts
interface IndexConfiguration {
  parserName: string;
  parserVersion: string;

  chunkerName: string;
  chunkerVersion: string;

  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimensions: number;
}
```

---

# 106. System dashboard

System page:

```text
Database
✓ PostgreSQL

Storage
✓ S3

Embedding
✓ local
Model: ...
Dimensions: 384

Workers
3 active

Queue
2 jobs pending

Documents
1,243

Chunks
184,220

MCP
✓ enabled
```

---

# 107. Jobs dashboard

Display:

```text
queued
running
failed
completed
```

Include:

```text
document
attempt
worker
duration
error
retry action
```

---

# 108. Error model

HTTP errors should use a consistent structure.

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document was not found.",
    "requestId": "req_..."
  }
}
```

Do not expose internal stack traces in production responses.

---

# 109. Pagination

Prefer cursor pagination.

Example:

```json
{
  "items": [],
  "nextCursor": "..."
}
```

Avoid offset pagination for large document/chunk tables.

---

# 110. IDs

Use prefixed UUIDv7 strings.

```text
col_   collection
doc_   document
rev_   revision
chk_   chunk
job_   ingestion job
key_   api key
wh_    webhook
evt_   webhook delivery / event
req_   request id
```

Example: `doc_01J7Z3K…`. The prefix is part of the stored primary key. There is no `ws_` prefix.

---

# 111. TypeScript SDK

A small TypeScript client should eventually expose:

```ts
const client =
  new DocumentKnowledgeClient({
    baseUrl,
    apiKey
  });

await client.documents.upload(...);

await client.search({
  query: "..."
});
```

This may be v1.5.

---

# 112. Docker image

The default image should contain:

```text
Bun runtime
application (API + bundled React dashboard)
database migrations
default embedding model
AnyDoc native binary (or WASM fallback) for the image platform
```

Local example:

```bash
docker run \
  -p 3000:3000 \
  -v ./knowledge:/app/data \
  project/image
```

---

# 113. Local developer experience

Expected setup:

```bash
bun install

bun db:migrate

bun dev
```

`bun dev` starts one process on one port: API, MCP, and the React dashboard. No Vite, no second terminal.

No external database should be required for default development.

---

# 114. Production deployment

Typical:

```text
Load balancer
       │
       ▼
Bun API × N
       │
  ┌────┴─────┐
  ▼          ▼
Postgres     S3
  ▲
  │
Workers × N
```

Workers may share the same application image.

---

# 115. Backups

Canonical backup requirements:

Server:

```text
Postgres
S3
```

Local:

```text
SQLite/libSQL file
data directory
```

All indexes must be reconstructable from originals and metadata.

---

# 116. API versioning

Use:

```text
/api/v1
```

from the beginning.

MCP tools should avoid unnecessary version names unless breaking changes require them.

---

# 117. Testing strategy

## Unit tests

Cover:

```text
chunking
hashing
RRF
metadata filters
storage key generation
webhook signing
parser normalization
```

## Integration tests

Run against:

```text
libSQL
Postgres
local storage
S3-compatible test storage
```

## Retrieval tests

Create a fixed corpus and expected queries.

Example:

```text
query
expected relevant chunk IDs
expected top-K threshold
```

This creates a retrieval regression suite.

---

# 118. Retrieval quality regression

The repository should contain:

```text
test corpus
queries
expected matches
```

CI should report metrics such as:

```text
Recall@5
Recall@10
MRR
```

This is particularly important as chunking and embedding configurations evolve.

---

# 119. Performance targets

Initial targets, not hard guarantees:

Local mode:

```text
startup < 5s excluding first model load
search < 250ms typical small corpus
dashboard search feedback < 500ms
```

Server mode:

```text
search p95 < 500ms excluding extreme filters
```

Ingestion throughput should be measured rather than initially guaranteed.

---

# 120. Search result limits

```env
DEFAULT_SEARCH_LIMIT=8
MAX_SEARCH_LIMIT_API=50
MAX_SEARCH_LIMIT_MCP=20
MAX_LIST_LIMIT=100
MAX_NEIGHBORS_BEFORE=5
MAX_NEIGHBORS_AFTER=5
MAX_SECTION_CHUNKS=40
MAX_DOCUMENT_EXPAND_CHUNKS=80
MAX_MCP_DOCUMENT_CHARS=32000
```

`limit` above the interface maximum is clamped, not rejected.

Expansion:

```text
neighbors: before ≤ 5, after ≤ 5
section:   ≤ 40 chunks sharing the parent heading
document:  ≤ 80 chunks; larger documents must use search + neighbors
```

---

# 121. MCP context safety

Avoid returning enormous text bodies by default.

For large sources:

```text
search
↓
small relevant chunks
↓
optional explicit expansion
```

This allows models to manage their own context budget.

---

# 122. Database schema

Drizzle owns migrations. Two dialect folders share the same column names: `packages/db/schema/libsql` and `packages/db/schema/postgres`. Vector and FTS objects are dialect SQL in those migrations, not pretended to be identical.

IDs are prefixed UUIDv7 text (§110). Timestamps are timestamptz (Postgres) or integer epoch ms (libSQL). JSON is jsonb / text. Booleans are boolean / integer 0|1.

## 122.1 Tables (Drizzle)

```ts
api_keys {
  id            text PK
  name          text not null
  key_prefix    text not null
  key_hash      text not null unique
  scopes        json not null default []
  created_at    timestamptz not null
  last_used_at  timestamptz null
  revoked_at    timestamptz null
}

collections {
  id            text PK
  name          text not null
  description   text null
  created_at    timestamptz not null
  updated_at    timestamptz not null
}

documents {
  id                    text PK
  collection_id         text null → collections.id on delete set null
  current_revision_id   text null → document_revisions.id on delete set null
  title                 text null
  original_filename     text not null
  mime_type             text not null
  extension             text null
  size_bytes            integer not null
  sha256                text not null
  status                text not null
    // pending | processing | ready | failed | deleting | deleted
  metadata              json not null default {}
  latest_error          text null
  created_at            timestamptz not null
  updated_at            timestamptz not null
  deleted_at            timestamptz null
}

document_revisions {
  id                    text PK
  document_id           text not null → documents.id on delete cascade
  revision              integer not null
  storage_key           text not null
  sha256                text not null
  size_bytes            integer not null
  parser_name           text not null
  parser_version        text not null
  chunker_name          text not null
  chunker_version       text not null
  embedding_model       text not null
  embedding_dimensions  integer not null
  embedding_version     text not null
  normalized_storage_key text null
  chunk_count           integer not null default 0
  created_at            timestamptz not null
  unique (document_id, revision)
}

document_chunks {
  id              text PK
  collection_id   text null
  document_id     text not null → documents.id on delete cascade
  revision_id     text not null → document_revisions.id on delete cascade
  sequence        integer not null
  content         text not null
  embedding_text  text not null
  heading_path    json not null default []
  location        json null
  token_count     integer not null
  metadata        json not null default {}
  content_hash    text not null
  created_at      timestamptz not null
  unique (revision_id, sequence)
  unique (revision_id, content_hash)
}

ingestion_jobs {
  id            text PK
  document_id   text not null → documents.id on delete cascade
  revision_id   text not null → document_revisions.id on delete cascade
  status        text not null
    // queued | running | completed | failed | retrying | cancelled
  attempt       integer not null default 0
  max_attempts  integer not null default 3
  locked_by     text null
  locked_at     timestamptz null
  started_at    timestamptz null
  completed_at  timestamptz null
  error         text null
  created_at    timestamptz not null
  updated_at    timestamptz not null
}

webhooks {
  id          text PK
  url         text not null
  events      json not null
  secret      text not null
  enabled     integer not null default 1
  created_at  timestamptz not null
  updated_at  timestamptz not null
}

webhook_deliveries {
  id              text PK
  webhook_id      text not null → webhooks.id on delete cascade
  event_id        text not null
  event_type      text not null
  payload         json not null
  status          text not null
    // pending | delivered | failed
  attempt         integer not null default 0
  http_status     integer null
  last_error      text null
  next_retry_at   timestamptz null
  created_at      timestamptz not null
  delivered_at    timestamptz null
}

system_settings {
  key         text PK
  value       json not null
  updated_at  timestamptz not null
}
```

`system_settings` key `index_configuration` stores `IndexConfiguration`.

## 122.2 Indexes (shared)

```text
documents (collection_id)
documents (status)
documents (deleted_at)
unique documents (sha256) WHERE deleted_at IS NULL
document_revisions (document_id)
document_chunks (document_id, sequence)
document_chunks (revision_id)
ingestion_jobs (status, created_at)
ingestion_jobs (revision_id)
webhook_deliveries (webhook_id, created_at)
webhook_deliveries (status, next_retry_at)
```

At most one active job per revision:

```text
unique ingestion_jobs (revision_id) WHERE status IN ('queued', 'running', 'retrying')
```

## 122.3 Vector column

Not modeled as a separate table. `document_chunks` carries the embedding.

Postgres (pgvector, cosine):

```sql
ALTER TABLE document_chunks
  ADD COLUMN embedding vector(384);

CREATE INDEX document_chunks_embedding_idx
  ON document_chunks
  USING hnsw (embedding vector_cosine_ops);
```

libSQL:

```sql
ALTER TABLE document_chunks
  ADD COLUMN embedding F32_BLOB(384);

CREATE INDEX document_chunks_embedding_idx
  ON document_chunks (libsql_vector_idx(embedding));
```

Insert only after embed. Search uses cosine distance. Application SQL stays behind `VectorIndex`; Drizzle does not wrap the KNN operator.

## 122.4 Lexical index

Postgres:

```sql
ALTER TABLE document_chunks
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(content, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(heading_path::text, '')), 'B')
  ) STORED;

CREATE INDEX document_chunks_search_idx
  ON document_chunks USING gin (search_tsv);
```

(`heading_path` is jsonb; `::text` is good enough for FTS. Do not use a subquery inside a generated column.)

libSQL FTS5:

```sql
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  content,
  heading_path,
  tokenize = 'unicode61'
);

-- AFTER INSERT/UPDATE/DELETE on document_chunks
-- keep document_chunks_fts aligned (chunk_id = id, heading_path = joined text)
```

Query shape:

```text
Postgres:  search_tsv @@ plainto_tsquery('simple', :query)
           ORDER BY ts_rank(search_tsv, query) DESC
           LIMIT :lexical_candidates

libSQL:    SELECT chunk_id, rank
           FROM document_chunks_fts
           WHERE document_chunks_fts MATCH :query
           ORDER BY rank
           LIMIT :lexical_candidates
```

Then join `document_chunks` and apply collection/document/metadata filters.

## 122.5 Metadata filters

`documents.metadata` and `document_chunks.metadata` are JSON. v1 operators (`eq`, `neq`, `in`, `exists`, `gte`, `lte`) compile to:

```text
Postgres:  metadata->>'department' = $1
           (metadata->>'year')::numeric >= $1
libSQL:    json_extract(metadata, '$.department') = $1
           CAST(json_extract(metadata, '$.year') AS REAL) >= $1
```

No GIN/json index in v1 unless a corpus measurement requires it.

There is no `workspaces` table.

---

# 123. Suggested services

```ts
DocumentService
CollectionService
IngestionService
ChunkingService
EmbeddingService
RetrievalService
StorageService
JobService
WebhookService
SystemService
```

---

# 124. Internal dependency direction

Preferred:

```text
HTTP/MCP/UI
    ↓
application services
    ↓
domain
    ↓
interfaces
    ↓
adapters
```

Avoid adapter-to-application imports.

---

# 125. Development phases

## Phase 1 — Core foundation

Implement:

```text
Bun project
Drizzle schema in §122
libSQL
collections
documents
filesystem storage
upload API
document listing
document deletion
React + shadcn + Tailwind dashboard in the same Bun.serve() process
```

Acceptance:

- a user can upload a document;
- it is persisted;
- it can be listed and deleted.

---

## Phase 2 — Ingestion

Implement:

```text
DocumentParser registry
AnyDoc adapter (toDocument → NormalizedDocument)
native-text adapters (txt, md, html, json, xml)
normalized document persistence
durable jobs
worker
chunking
ingestion state
AnyDoc error mapping (including needsOcr)
```

Acceptance:

- office/PDF/CSV uploads become normalized via AnyDoc;
- text formats become normalized via first-party adapters;
- chunks are persisted;
- scanned PDFs fail as `DOCUMENT_NEEDS_OCR` in the dashboard;
- failed jobs can be retried.

---

## Phase 3 — Local embeddings

Implement:

```text
Transformers.js
vendored Xenova/all-MiniLM-L6-v2 (uint8 ONNX, 384-d)
embedding batching
vector storage (F32_BLOB / vector(384))
```

Acceptance:

- no external AI service is required;
- ingestion generates embeddings;
- semantic vector search works.

---

## Phase 4 — Retrieval

Implement:

```text
libSQL FTS5 / Postgres tsvector (simple)
vector search
hybrid search (50 + 50 candidates, RRF k=60)
metadata filters
context expansion
```

Acceptance:

- search supports all three modes;
- results preserve provenance;
- neighboring context can be fetched.

---

## Phase 5 — MCP

Implement:

```text
Streamable HTTP MCP
stdio optional

search_documents
get_document
get_chunk
list_documents
list_collections
```

Acceptance:

- an MCP-compatible client can search uploaded documents;
- search results can resolve to exact chunks;
- MCP does not require external LLM infrastructure.

---

## Phase 6 — Retrieval playground

Implement:

```text
query editor
filters
search mode
result inspection
score breakdown
latency breakdown
neighbor expansion
section expansion
```

Acceptance:

- users can reproduce MCP/API searches;
- users can inspect why results ranked.

---

## Phase 7 — Postgres/server deployment

Implement:

```text
Postgres Drizzle adapter
pgvector
server-safe job locking
```

Acceptance:

- changing configuration from libSQL to Postgres requires no application-code changes;
- search behavior is functionally equivalent.

---

## Phase 8 — S3

Implement:

```text
Bun S3 storage adapter
S3-compatible endpoints
```

Acceptance:

- stateless workers can ingest any document;
- multiple API instances can access originals.

---

## Phase 9 — Observability

Implement:

```text
structured logging
health
readiness
system status
metrics
search traces
job dashboard
```

---

## Phase 10 — Webhooks

Implement:

```text
webhook config
signed payloads
retries
delivery history
test endpoint
```

---

# 126. v1 release criteria

The first stable release should support:

### Deployment

- Bun runtime;
- Docker;
- local profile;
- server profile;
- libSQL;
- Postgres;
- local filesystem;
- S3-compatible storage.

### Documents

- upload;
- URL ingestion;
- arbitrary metadata;
- collections;
- delete;
- reindex;
- revisions;
- normalized document representation.

### Retrieval

- local embeddings;
- vector search;
- lexical search;
- hybrid search;
- RRF;
- provenance;
- metadata filtering;
- chunk context expansion;
- parent section expansion.

### Interfaces

- REST API;
- MCP HTTP;
- MCP stdio optional;
- lightweight dashboard.

### Developer tooling

- retrieval playground;
- explain search;
- structured logs;
- health/readiness;
- metrics.

### Integrations

- webhooks.

---

# 127. Features intentionally deferred

Do not add these before core stability:

```text
chat interface

agent orchestration

hosted LLM integration

conversation memory

prompt templates

workflow engine

browser crawler

website indexing platform

hosted Firecrawl OCR / scanned-PDF support
advanced OCR pipeline UI

enterprise RBAC

SSO/SAML

reranker model

knowledge graph

automatic summaries

AI-generated tags
```

They can be added later as independent modules if real demand exists.

---

# 128. Potential future features

Possible future additions:

```text
folder/directory sync

GitHub repository ingestion

Google Drive ingestion

Dropbox ingestion

Notion ingestion

scheduled URL refresh

automatic source synchronization

document-level permissions

workspaces / multi-tenancy

multiple embedding indexes

index A/B testing

retrieval quality analytics

external reranking

document preview with source highlighting

citation bounding boxes

OCR worker isolation

websocket/SSE ingestion progress

SDKs for Python and Go
```

---

# 129. Project identity

The system should be positioned as infrastructure rather than an AI assistant.

Potential description:

> A self-hostable document knowledge service that ingests files, indexes them locally, and exposes explainable retrieval over MCP and HTTP.

Shorter:

> Turn documents into a queryable MCP knowledge service.

Key traits:

```text
local-first
deployable
MCP-native
LLM-independent
observable
explainable
extensible
```

---

# 130. Architectural summary

```text
                     ┌──────────────────────┐
                     │      Dashboard       │
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
                     │       HTTP API       │
                     └──────────┬───────────┘
                                │
       ┌────────────────────────┼─────────────────────┐
       │                        │                     │
       ▼                        ▼                     ▼
Document Service        Retrieval Service      Webhook Service
       │                        │
       ▼                        ▼
Ingestion Service        Hybrid Retrieval
       │                  ┌─────┴─────┐
       ▼                  ▼           ▼
Parser                 Vector       Lexical
       │
       ▼
Normalizer
       │
       ▼
Chunker
       │
       ▼
Local Embedder
       │
       ├─────────────────────┐
       ▼                     ▼
Knowledge Repository     Vector Index
       │                     │
  ┌────┴────┐           ┌────┴─────┐
  ▼         ▼           ▼          ▼
libSQL   Postgres    libSQL      pgvector

              Object Store
             ┌──────┴──────┐
             ▼             ▼
           Local           S3


             MCP Adapter
                 │
                 ▼
          MCP-compatible agents
```

---

# 131. Core success metric

A successful implementation should make the following workflow trivial:

```text
Upload arbitrary document
        ↓
Wait for ready
        ↓
Ask natural-language question
        ↓
Receive relevant chunks
        ↓
Inspect exactly why they matched
        ↓
Expand context when required
        ↓
Trace every answer back to source
```

while being deployable either as:

```text
one Bun container
```

or:

```text
a horizontally scalable Bun + Postgres + S3 service
```

without changing the application architecture.

---

# 132. Final product principle

When considering new functionality, prefer features that improve:

```text
ingestion
retrieval
inspectability
portability
integration
operability
```

over features that turn the system into a general-purpose AI application.

The product should remain:

> Simple to run. Easy to inspect. Predictable to integrate.