# Retrieval Phase 3: Document Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explainable distinct-document retrieval and an ASR-friendly lexical fallback.

**Architecture:** Preserve chunk RRF as the primitive, then collapse fused candidates deterministically in `SearchService`. Extend the libSQL lexical adapter with exact and fallback passes and a title-aware FTS migration.

**Tech Stack:** TypeScript, libSQL/SQLite FTS5, RRF, Bun tests and retrieval evaluator.

**Spec:** `docs/superpowers/specs/2026-09-23-magic-voice-retrieval-design.md`

## Global Constraints

- Chunk-mode search remains the default.
- Document collapse uses best fused chunk; no opaque reranker.
- Candidate pools stay bounded at configured vector/lexical limits.
- Exact identifier lookup remains an all-terms pass.
- Title, heading, and content ranking stays inspectable.

## Review Focus

- One document occupying most candidates must not produce duplicate collapsed results.
- Equal scores and ranks produce deterministic document-id ordering.
- One-term/SKU queries never enter a weakened multi-term fallback.
- Stop-word-only queries return cleanly without invalid FTS syntax.
- Filtered searches apply filters inside exact and fallback candidate queries.

---

### Task 1: Pure document collapse

**Files:**
- Create: `packages/core/src/retrieval/collapse.ts`
- Create: `tests/unit/collapse.test.ts`
- Modify: `packages/core/src/domain/types.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `collapseSearchHits(hits: SearchHit[], limit: number): CollapsedSearchHit[]`

- [ ] **Step 1: Write failing collapse tests**

Use multiple chunks per document, tied scores, repeated headings, and a limit smaller than the
distinct-document count. Assert best chunk preservation, `matchingChunkCount`, unique headings, and
deterministic order.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/unit/collapse.test.ts`  
Expected: FAIL because the helper is absent.

- [ ] **Step 3: Implement minimal collapse**

Group in ranked input order. The first hit is the representative; accumulate counts and heading
strings; sort only ties using `documentId`; return `slice(0, limit)`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/collapse.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/retrieval/collapse.ts packages/core/src/domain/types.ts packages/core/src/index.ts tests/unit/collapse.test.ts
git commit -m "feat: collapse ranked chunks by document"
```

### Task 2: SearchService, REST, and MCP collapse mode

**Files:**
- Modify: `packages/core/src/services/search-service.ts`
- Modify: `apps/server/src/http/router.ts`
- Modify: `apps/server/src/mcp/handler.ts`
- Modify: `tests/integration/hybrid-search.test.ts`
- Modify: `tests/integration/mcp.test.ts`

- [ ] **Step 1: Add failing end-to-end tests**

Create one document with several highly matching chunks and two other matching documents. Assert
`collapse: "document"` returns distinct ids through REST and MCP while omitted collapse preserves
chunk mode.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/integration/hybrid-search.test.ts tests/integration/mcp.test.ts`  
Expected: FAIL because `collapse` is ignored.

- [ ] **Step 3: Add the optional service input**

Extend `SearchService.search` with `collapse?: "none" | "document"`. Build all candidate hits before
the final requested limit when collapsing, then call `collapseSearchHits`; reject unknown modes at
the adapters.

- [ ] **Step 4: Run tests, typecheck, and commit**

Run: `bun test tests/unit/collapse.test.ts tests/integration/hybrid-search.test.ts tests/integration/mcp.test.ts`  
Expected: PASS.  
Run: `bun run typecheck`  
Expected: exit 0.

```bash
git add packages/core/src/services/search-service.ts apps/server/src/http/router.ts apps/server/src/mcp/handler.ts tests/integration/hybrid-search.test.ts tests/integration/mcp.test.ts
git commit -m "feat: add document-collapsed search"
```

### Task 3: Title-aware exact and fallback FTS

**Files:**
- Create: `drizzle/0006_fts_titles.sql`
- Modify: `packages/retrieval/src/lexical/libsql-fts.ts`
- Modify: `packages/core/src/ports.ts`
- Create: `tests/integration/lexical-fallback.test.ts`
- Modify: `tests/unit/lexical.test.ts`

- [ ] **Step 1: Add failing lexical tests**

Cover exact identifier ranking, noisy spoken queries, title-only matches, two-of-three eligible
terms, stop-word-only input, filters, and deterministic exact-before-fallback ordering.

- [ ] **Step 2: Run tests**

Run: `bun test tests/unit/lexical.test.ts tests/integration/lexical-fallback.test.ts`  
Expected: FAIL before migration and fallback support.

- [ ] **Step 3: Migrate and implement two passes**

Recreate/backfill FTS with `chunk_id UNINDEXED, title, heading_path, content`. Exact uses quoted
tokens joined by `AND`; fallback removes the static stop-word set and joins remaining tokens by
`OR`. Query `bm25(document_chunks_fts, 0.0, 8.0, 4.0, 1.0)` and label hits with
`lexicalMatchMode: "exact" | "fallback"`. Append fallback hits only after exact hits, deduped by
chunk id, until `limit`.

- [ ] **Step 4: Run focused tests and migration idempotence**

Run: `bun test tests/unit/lexical.test.ts tests/integration/lexical-fallback.test.ts`  
Expected: PASS.  
Run: `bun db:migrate` twice  
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0006_fts_titles.sql packages/retrieval/src/lexical/libsql-fts.ts packages/core/src/ports.ts tests/unit/lexical.test.ts tests/integration/lexical-fallback.test.ts
git commit -m "feat: add title-aware lexical fallback"
```

### Task 4: Magic Voice retrieval evaluation and release docs

**Files:**
- Create: `tests/retrieval/magic-voice-queries.json`
- Modify: `tests/retrieval/recall.test.ts`
- Modify: `tests/retrieval/evaluator.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add anonymized queries and distinct-document assertions**

Include filler-heavy project questions, exact model/SKU-like identifiers, confusable projects, and
no-answer speech. Assert distinct-document recall and the existing latency report shape.

- [ ] **Step 2: Run retrieval tests and record evidence**

Run: `bun test tests/retrieval/recall.test.ts`  
Expected: PASS with printed document-level metrics.

- [ ] **Step 3: Run complete gates**

Run: `bun test`  
Expected: all tests pass.  
Run: `bun run typecheck`  
Expected: exit 0.  
Run: `git diff --check`  
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add tests/retrieval README.md CHANGELOG.md
git commit -m "test: gate Magic Voice document retrieval"
```
