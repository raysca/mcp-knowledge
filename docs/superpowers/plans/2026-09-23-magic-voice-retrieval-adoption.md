# Magic Voice Retrieval Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt safe document pages, collapsed search, and the versioned catalog in Magic Voice while retaining compatibility with older MCP Knowledge images.

**Architecture:** Worker-side capability detection selects new MCP behavior only when advertised. Project Loader assembles pages before parsing and memoizes only complete documents; the closed index prefers explicit catalog metadata and falls back to legacy filenames.

**Tech Stack:** Python 3.11, strict mypy, Ruff, pytest, Pipecat MCP client.

**Spec:** `/Users/rottun/Projects/mcp-knowledge/docs/superpowers/specs/2026-09-23-magic-voice-retrieval-design.md`

## Global Constraints

- Listen never speaks and its model never calls MCP.
- Fetch state is per session; catalog cache is process-wide.
- Older MCP Knowledge images remain supported.
- At most 20 document pages are assembled per fetch.
- Filename classification remains only as a compatibility fallback.

## Review Focus

- Repeated cursors stop with `document_unreadable`, never an infinite loop.
- A later-page transport failure does not memoize a partial document.
- Mixed old/new workers and servers select a valid capability path.
- Explicit unknown `documentType` does not fall back to a contradictory filename.
- Duplicate catalog pages cannot duplicate prompt entries.

---

### Task 1: Assemble paged documents

**Files:**
- Modify: `/Users/rottun/Projects/home-depot-magic-voice/apps/ai-pipeline/src/ai_pipeline/pipeline/listen/project_loader.py`
- Test: `/Users/rottun/Projects/home-depot-magic-voice/apps/ai-pipeline/tests/unit/test_listen_project_loader.py`

**Interfaces:**
- Produces: `ProjectLoader._fetch_document_pages(doc_id: str) -> dict[str, Any]`

- [ ] **Step 1: Add failing async tests**

Return two valid block-envelope pages and assert ordered assembly, two `mcp_calls`, and memoization
of only the complete payload. Add repeated-cursor, 21-page, and second-page-failure cases.

- [ ] **Step 2: Verify failure**

Run from `apps/ai-pipeline`: `uv run pytest tests/unit/test_listen_project_loader.py -q`  
Expected: FAIL because only one page is fetched.

- [ ] **Step 3: Implement bounded assembly**

Parse each `body`, require an object with `blocks`, append blocks, and request subsequent pages with
`{"document_id": doc_id, "block_cursor": cursor}`. Track seen cursors and stop at 20. Return first-page
metadata with one re-serialized body and pagination fields removed.

- [ ] **Step 4: Run the focused test**

Run: `uv run pytest tests/unit/test_listen_project_loader.py -q`  
Expected: PASS.

- [ ] **Step 5: Run static checks**

Run: `uv run ruff check src tests/unit/test_listen_project_loader.py`  
Expected: exit 0.  
Run: `uv run mypy src`  
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/ai-pipeline/src/ai_pipeline/pipeline/listen/project_loader.py apps/ai-pipeline/tests/unit/test_listen_project_loader.py
git commit -m "feat(listen): assemble paged knowledge documents"
```

### Task 2: Prefer the typed catalog

**Files:**
- Modify: `/Users/rottun/Projects/home-depot-magic-voice/apps/ai-pipeline/src/ai_pipeline/pipeline/listen/knowledge_index.py`
- Test: `/Users/rottun/Projects/home-depot-magic-voice/apps/ai-pipeline/tests/unit/test_listen_knowledge_index.py`

**Interfaces:**
- Produces: catalog-first `build_index` with legacy `list_documents` fallback
- Produces: `KnowledgeIndex.corpus_version: str | None`

- [ ] **Step 1: Add failing catalog/fallback tests**

Cover all three recognized document types, unchanged-version responses, missing-tool fallback,
conflicting metadata versus filename, duplicate ids, and cursor paging.

- [ ] **Step 2: Verify failure**

Run: `uv run pytest tests/unit/test_listen_knowledge_index.py -q`  
Expected: FAIL because only `list_documents` exists.

- [ ] **Step 3: Implement capability-driven selection**

Pass advertised knowledge-tool names into the index source. Use `list_document_catalog` when present,
send cached `if_corpus_version`, and classify recognized explicit metadata. Exclude explicit unknown
types; use filename classification only for legacy pages or absent metadata.

- [ ] **Step 4: Run the focused test**

Run: `uv run pytest tests/unit/test_listen_knowledge_index.py -q`  
Expected: PASS.

- [ ] **Step 5: Run static checks**

Run: `uv run ruff check src tests/unit/test_listen_knowledge_index.py`  
Expected: exit 0.  
Run: `uv run mypy src`  
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/ai-pipeline/src/ai_pipeline/pipeline/listen/knowledge_index.py apps/ai-pipeline/tests/unit/test_listen_knowledge_index.py
git commit -m "feat(listen): prefer typed knowledge catalogs"
```

### Task 3: Request collapsed Ask searches when supported

**Files:**
- Modify: `/Users/rottun/Projects/home-depot-magic-voice/apps/ai-pipeline/src/ai_pipeline/pipeline/mcp_tools.py`
- Test: `/Users/rottun/Projects/home-depot-magic-voice/apps/ai-pipeline/tests/unit/test_mcp_tools_guide_cards.py`

- [ ] **Step 1: Add failing compatibility tests**

When the knowledge search schema advertises `collapse`, assert the wrapper adds
`collapse: "document"`; with an old schema, arguments remain unchanged. Guide-card observation must
accept both result shapes.

- [ ] **Step 2: Verify failure**

Run: `uv run pytest tests/unit/test_mcp_tools_guide_cards.py -q`  
Expected: FAIL because schema-gated enrichment is absent.

- [ ] **Step 3: Implement schema-gated enrichment**

Record discovered input-schema properties when sessions start. Before a knowledge
`search_documents` call, copy arguments and add collapse only when advertised and unset.

- [ ] **Step 4: Run the focused test**

Run: `uv run pytest tests/unit/test_mcp_tools_guide_cards.py -q`  
Expected: PASS.

- [ ] **Step 5: Run static checks**

Run: `uv run ruff check src tests/unit/test_mcp_tools_guide_cards.py`  
Expected: exit 0.  
Run: `uv run mypy src`  
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/ai-pipeline/src/ai_pipeline/pipeline/mcp_tools.py apps/ai-pipeline/tests/unit/test_mcp_tools_guide_cards.py
git commit -m "feat(ask): prefer document-collapsed knowledge search"
```

### Task 4: Cross-service verification

- [ ] **Step 1: Verify MCP Knowledge**

Run from `/Users/rottun/Projects/mcp-knowledge`: `bun test`  
Expected: all tests pass.  
Run: `bun run typecheck`  
Expected: exit 0.

- [ ] **Step 2: Verify Magic Voice integration**

Run from `apps/ai-pipeline`: `uv run pytest tests/unit/test_listen_project_loader.py tests/unit/test_listen_knowledge_index.py tests/unit/test_mcp_tools_guide_cards.py -q`  
Expected: PASS.

- [ ] **Step 3: Record the compatible image digest**

Update the Magic Voice deployment note with the first MCP Knowledge digest containing all server
phases; retain feature detection as the rollback path.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: record knowledge retrieval compatibility"
```
