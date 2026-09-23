# Retrieval Phase 2: Safe Document Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace invalid string truncation with revision-bound, block-safe document pagination.

**Architecture:** A core paging module selects normalized blocks and owns opaque cursor validation. `DocumentService` loads the normalized source and applies that module; REST and MCP are thin transports over the same result.

**Tech Stack:** Bun, TypeScript, normalized-document domain types, base64url cursors, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-23-magic-voice-retrieval-design.md`

## Global Constraints

- `body` is always valid JSON and never exceeds `MAX_MCP_DOCUMENT_CHARS`.
- Cursors bind document id, revision id, next block index, and heading selection.
- Small-document requests retain current fields and complete content.
- Pages are bounded; a single unpageable block returns `DOCUMENT_BLOCK_TOO_LARGE`.
- No storage key appears in a response or cursor.

## Review Focus

- Multibyte Unicode near the character ceiling must not corrupt JSON.
- A cursor from another document or revision returns `CURSOR_STALE`.
- Invalid base64/JSON and negative cursor positions return `INVALID_CURSOR`.
- Repeated heading names select each matching section without crossing into unrelated headings.
- A page can make progress even when envelope metadata consumes most of the ceiling.

---

### Task 1: Pure normalized-block pager

**Files:**
- Create: `packages/core/src/services/document-page.ts`
- Create: `tests/unit/document-page.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `pageNormalizedDocument(input: DocumentPageInput): DocumentPageResult`
- Produces: `encodeBlockCursor` and `decodeBlockCursor`

- [ ] **Step 1: Write failing table-driven tests**

Cover complete documents, multi-page reconstruction, heading selection, Unicode boundaries,
oversized single blocks, malformed cursors, cross-document cursors, and revision changes.

- [ ] **Step 2: Run the focused test**

Run: `bun test tests/unit/document-page.test.ts`  
Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement block-safe selection**

Define:

```ts
type DocumentPageInput = {
  documentId: string; revisionId: string; normalized: NormalizedDocument;
  cursor?: string; blockLimit: number; maxChars: number; headings?: string[];
};
type DocumentPageResult = {
  body: string; truncated: boolean; nextBlockCursor?: string;
  returnedBlocks: number; totalBlocks: number;
};
```

Serialize after each candidate block and stop before exceeding `maxChars`. Compare decoded cursor
bindings before using its index. Heading selection walks from a matching heading until the next
heading of equal or lower level.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/unit/document-page.test.ts`  
Expected: PASS.  
Run: `bun run typecheck`  
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/document-page.ts packages/core/src/index.ts tests/unit/document-page.test.ts
git commit -m "feat: page normalized documents by block"
```

### Task 2: DocumentService and REST reuse

**Files:**
- Modify: `packages/core/src/services/document-service.ts`
- Modify: `apps/server/src/http/router.ts`
- Modify: `tests/integration/documents-api.test.ts`

**Interfaces:**
- Produces: `DocumentService.normalizedPage(id, options): Promise<DocumentPageResult>`
- Produces: `GET /api/v1/documents/:id/normalized`

- [ ] **Step 1: Add failing API tests**

Upload a document whose normalized form exceeds a test ceiling, walk `nextBlockCursor` until absent,
assert every `body` parses, and assert concatenated blocks equal the normalized source. Add stale and
tampered cursor cases.

- [ ] **Step 2: Run the focused integration test**

Run: `bun test tests/integration/documents-api.test.ts`  
Expected: FAIL because the endpoint is absent.

- [ ] **Step 3: Implement service and route**

Load the current revision and normalized blob once in `normalizedPage`, then call the pure pager.
Map query parameters `blockCursor`, `blockLimit`, and repeated `heading` values through the HTTP
adapter's existing `clampLimit`; the core pager independently rejects unsafe service input.

- [ ] **Step 4: Run focused tests**

Run: `bun test tests/unit/document-page.test.ts tests/integration/documents-api.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/document-service.ts apps/server/src/http/router.ts tests/integration/documents-api.test.ts
git commit -m "feat: expose paged normalized documents"
```

### Task 3: Replace MCP truncation

**Files:**
- Modify: `apps/server/src/mcp/handler.ts`
- Modify: `tests/integration/mcp.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add failing MCP compatibility tests**

Assert small documents retain a parseable full body; large documents return parseable pages with
`nextBlockCursor`; heading selection works; stale cursors return `isError: true` with `CURSOR_STALE`.

- [ ] **Step 2: Run the test and observe the sliced-JSON failure**

Run: `bun test tests/integration/mcp.test.ts`  
Expected: FAIL because current `body.slice` is not valid JSON.

- [ ] **Step 3: Delegate to `normalizedPage`**

Add `block_cursor`, `block_limit`, and `headings` to the schema. Remove direct serialization and
`slice`; merge the page result with document metadata.

- [ ] **Step 4: Run complete verification**

Run: `bun test`  
Expected: all tests pass.  
Run: `bun run typecheck`  
Expected: exit 0.  
Run: `git diff --check`  
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mcp/handler.ts tests/integration/mcp.test.ts README.md CHANGELOG.md
git commit -m "fix: return structurally valid MCP document pages"
```
