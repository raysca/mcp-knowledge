# Retrieval Phase 4: Versioned Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a cheap, versioned document-selection catalog with explicit ingestion metadata.

**Architecture:** Repository triggers maintain a monotonic corpus generation. A catalog service exposes projected ready-document metadata through REST and MCP. A generic ingest manifest applies path-based metadata before documents are created.

**Tech Stack:** TypeScript, libSQL migrations/triggers, Bun.Glob, MCP/REST adapters, Bun tests.

**Spec:** `docs/superpowers/specs/2026-09-23-magic-voice-retrieval-design.md`

## Global Constraints

- Existing `list_documents` remains unchanged.
- Catalog output never exposes storage keys, hashes not requested by the fixed projection, or blobs.
- Corpus generation changes on live document create/update/status/delete transitions.
- Metadata rules are generic path globs, never Home Depot-specific code.
- Magic Voice retains filename fallback during rolling deployment.

## Review Focus

- Generation changes when status becomes ready even if document count does not change.
- Failed/deleted transitions invalidate a previously ready catalog.
- Cursor paging remains stable when documents share timestamps.
- Invalid projections and metadata filters fail before SQL construction.
- Malformed or escaping manifest paths cannot attach metadata to unrelated files.

---

### Task 1: Corpus generation and catalog repository query

**Files:**
- Create: `drizzle/0007_document_catalog.sql`
- Modify: `packages/core/src/ports.ts`
- Modify: `packages/db/src/libsql-repository.ts`
- Create: `tests/unit/document-catalog-repository.test.ts`

**Interfaces:**
- Produces: `KnowledgeRepository.getCorpusGeneration(): Promise<number>`
- Produces: `KnowledgeRepository.listDocumentCatalog(query): Promise<CatalogPage>`

- [ ] **Step 1: Write failing repository tests**

Assert generation increments for create, title/status update, and soft delete; catalog filters ready
documents, paginates duplicate timestamps, and returns only projected fields.

- [ ] **Step 2: Run tests**

Run: `bun test tests/unit/document-catalog-repository.test.ts`  
Expected: FAIL because migration and methods are absent.

- [ ] **Step 3: Add migration and repository methods**

Create singleton `corpus_state(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL)` and
document insert/update/delete triggers that increment it. Add an ordered catalog query using the
existing `(created_at,id)` cursor convention plus status, collection, and parsed metadata filters.

- [ ] **Step 4: Run tests and migration twice**

Run: `bun test tests/unit/document-catalog-repository.test.ts`  
Expected: PASS.  
Run: `bun db:migrate` twice  
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0007_document_catalog.sql packages/core/src/ports.ts packages/db/src/libsql-repository.ts tests/unit/document-catalog-repository.test.ts
git commit -m "feat: add versioned document catalog storage"
```

### Task 2: Catalog application service and transports

**Files:**
- Create: `packages/core/src/services/document-catalog-service.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/http/router.ts`
- Modify: `apps/server/src/mcp/handler.ts`
- Create: `tests/integration/document-catalog.test.ts`

**Interfaces:**
- Produces: `DocumentCatalogService.list(input): Promise<CatalogResponse>`
- Produces: `GET /api/v1/document-catalog`
- Produces: MCP tool `list_document_catalog`

- [ ] **Step 1: Add failing integration tests**

Assert complete pagination, `if_corpus_version` returning `{ corpusVersion, unchanged: true }`,
metadata filtering, fixed field projection, and MCP/REST parity.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/integration/document-catalog.test.ts`  
Expected: FAIL because service and routes are absent.

- [ ] **Step 3: Implement service and thin adapters**

Represent versions as `generation:<integer>`. Allow only `id`, `revisionId`, `title`, `sourcePath`,
`metadata`, `status`, and `updatedAt` in projection. The default projection is the first five.
Validate filters through `parseFilters` before calling the repository.

- [ ] **Step 4: Run tests, typecheck, and commit**

Run: `bun test tests/integration/document-catalog.test.ts`  
Expected: PASS.  
Run: `bun run typecheck`  
Expected: exit 0.

```bash
git add packages/core/src/services/document-catalog-service.ts packages/core/src/index.ts apps/server/src/app.ts apps/server/src/http/router.ts apps/server/src/mcp/handler.ts tests/integration/document-catalog.test.ts
git commit -m "feat: expose versioned document catalog"
```

### Task 3: Generic ingest metadata manifest

**Files:**
- Create: `apps/server/src/startup-scan/metadata-manifest.ts`
- Modify: `apps/server/src/startup-scan/local-directory-source.ts`
- Modify: `packages/core/src/services/source-import-service.ts`
- Create: `tests/unit/metadata-manifest.test.ts`
- Modify: `tests/integration/startup-directory-ingestion.test.ts`
- Modify: `docs/supported-formats.md`

**Interfaces:**
- Consumes: optional `.mcp-knowledge-manifest.json` in `INGEST_DATA_DIR`
- Produces: merged metadata for each relative source path

- [ ] **Step 1: Add failing parser and ingestion tests**

Use:

```json
{"rules":[{"glob":"articles/**/*.md","metadata":{"documentType":"project_guide"}}]}
```

Assert matching, nonmatching, precedence in file order, scalar/object metadata preservation,
malformed manifest rejection, and that the manifest itself is never ingested.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/unit/metadata-manifest.test.ts tests/integration/startup-directory-ingestion.test.ts`  
Expected: FAIL before manifest support.

- [ ] **Step 3: Implement manifest loading and metadata propagation**

Validate one top-level `rules` array, relative glob strings, and JSON-object metadata. Compile with
`Bun.Glob`; merge matching rules in order; pass the result through source import to document
creation. Reject absolute paths and `..` segments.

- [ ] **Step 4: Run tests and commit**

Run: `bun test tests/unit/metadata-manifest.test.ts tests/integration/startup-directory-ingestion.test.ts`  
Expected: PASS.

```bash
git add apps/server/src/startup-scan packages/core/src/services/source-import-service.ts tests/unit/metadata-manifest.test.ts tests/integration/startup-directory-ingestion.test.ts docs/supported-formats.md
git commit -m "feat: apply ingest metadata manifests"
```

### Task 4: Verify and document catalog release

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document catalog and manifest examples**

Show conditional refresh, metadata filters, fixed projections, and a generic two-rule manifest.

- [ ] **Step 2: Run complete verification**

Run: `bun test`  
Expected: all tests pass.  
Run: `bun run typecheck`  
Expected: exit 0.  
Run: `git diff --check`  
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe versioned document catalogs"
```
