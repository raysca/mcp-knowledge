# Magic Voice retrieval improvements

**Date:** 2026-09-23  
**Status:** Proposed  
**Primary consumer:** Magic Voice Ask and Listen surfaces

## Intent

Make MCP Knowledge safer and more efficient for applications that search a corpus, choose a
document, and fetch authoritative sections from it. The immediate consumer is Magic Voice, but
the APIs remain generic: no Home Depot document names, schemas, or ranking rules belong here.

Success means:

- `get_document` never returns a body made invalid by server-side truncation;
- callers can obtain neighboring or section context without fetching an entire document;
- search can return distinct documents rather than a list dominated by duplicate chunks;
- conversational queries retain lexical candidates without weakening exact identifier lookup;
- document catalogs can refresh cheaply and use explicit metadata instead of filename conventions;
- existing MCP callers continue to work unchanged.

## Constraints

- MCP stays a thin adapter over application services.
- REST and MCP use the same retrieval and document-fetch behavior.
- Retrieval remains explainable: ranks and source locations are preserved.
- Existing tool names and response fields remain backward compatible.
- Limits remain bounded; no request returns an unbounded document or result set.
- No hosted model, reranker, or application-specific dependency is introduced.

## Delivery strategy

Deliver four independently releasable phases:

1. Retrieval-adapter correctness and context controls.
2. Structurally safe document pagination.
3. Document-collapsed retrieval and spoken-query lexical fallback.
4. Versioned lightweight catalog and explicit document metadata.

## Phase 1: adapter correctness and context controls

### Bounded numeric arguments

Use one shared parser for MCP integer arguments. It accepts JSON numbers and integer-valued numeric
strings for compatibility, then enforces an inclusive minimum and maximum. Missing or non-finite
values use the documented default. Fractional, negative, zero, array, and object values return an
invalid-tool-arguments error rather than reaching SQL.

Apply it to `search_documents.limit`, `list_documents.limit`, `get_chunk.before` and
`get_chunk.after`, and the document page controls introduced in Phase 2.

### Search context controls

Expose the existing application-service expansion modes through `search_documents`:

```json
{
  "query": "how much mulch",
  "expand": { "type": "neighbors", "before": 1, "after": 2 }
}
```

Allowed expansion types are `none`, `neighbors`, and `section`. `document` expansion remains REST
only because it can create unexpectedly large MCP results and overlaps Phase 2's bounded fetch.
MCP also exposes existing structured metadata filters. Invalid filters use the existing
`INVALID_FILTER` application error.

`explain` remains REST-only. MCP search hits already expose stable ranks, while the larger
diagnostic payload belongs in the operator-facing API and Playground.

### Chunk context controls

Add optional `before` and `after` properties to `get_chunk` and pass them to
`DocumentService.chunk`. Both remain capped at five. The response remains `{ items: [...] }`, with
the requested chunk included in sequence order.

## Phase 2: structurally safe document pagination

### Problem

`get_document` currently serializes a normalized document and slices the JSON string at
`MAX_MCP_DOCUMENT_CHARS`. When truncation occurs, `body` is not valid JSON. A consumer cannot parse
the returned blocks or continue reliably.

### Contract

Extend `get_document` with optional bounded paging arguments:

```json
{
  "document_id": "doc_...",
  "block_cursor": "opaque-cursor",
  "block_limit": 50,
  "headings": ["Core Product", "Related Products (Cross-Sell)"]
}
```

The response keeps current document metadata and makes `body` a complete JSON envelope:

```json
{
  "id": "doc_...",
  "body": "{\"title\":\"...\",\"blocks\":[...]}",
  "truncated": true,
  "nextBlockCursor": "opaque-cursor",
  "returnedBlocks": 50,
  "totalBlocks": 137
}
```

Rules:

- Pages end only between normalized blocks.
- The character ceiling still applies. If one block cannot fit, return
  `DOCUMENT_BLOCK_TOO_LARGE` instead of corrupting JSON.
- Cursors bind the document id, current revision id, and next block index. A cursor used after a
  revision change returns `CURSOR_STALE`.
- `headings` selects complete heading sections before pagination. Matching is Unicode-normalized,
  trimmed, and case-insensitive but otherwise exact; unknown headings return an empty block page.
- With no paging arguments, return the largest structurally valid prefix that fits and a
  continuation cursor when more blocks exist. Small documents retain their current content.

Page selection lives in `DocumentService`, not the MCP handler, so REST can reuse it and unit tests
can exercise it without JSON-RPC.

## Phase 3: document-collapsed retrieval

Add an optional search property:

```json
{ "query": "raised garden bed", "collapse": "document", "limit": 8 }
```

Omitting `collapse` preserves today's chunk results. With `collapse: "document"`, the service:

1. retrieves the normal bounded vector and lexical candidate pools;
2. performs chunk-level RRF exactly as today;
3. groups fused candidates by document;
4. orders documents by their best chunk's fused rank, using document id as the deterministic final
   tie-breaker;
5. returns at most one result per document.

Each collapsed result retains the best chunk's fields and adds:

```json
{
  "matchingChunkCount": 3,
  "matchedHeadings": ["Materials", "Core Product"]
}
```

The result rank is the document rank; the ranking object still explains the selected best chunk.
This avoids a new opaque aggregation formula.

Collapsing can reduce the result count when a few documents dominate the bounded candidate pools.
The service does not issue unbounded follow-up searches. Returning fewer than `limit` distinct
documents is valid.

### Spoken-query lexical fallback

Exact identifiers such as SKUs and error codes must keep working, so lexical search uses two
explainable passes:

1. Existing all-terms (`AND`) FTS query.
2. Only when pass 1 returns too few candidates, an any-term (`OR`) fallback fills remaining slots.

Fallback results use FTS5 `bm25`, require at least two matching non-stop terms for queries with
three or more eligible terms, and never outrank an exact-pass result solely because they came from
the fallback. A small static English stop-word set affects the fallback only; the exact pass keeps
the original tokens.

Add document title to the lexical index and weight title, heading path, and content in that order.
The migration and index backfill must be transactional and repeatable.

Add an anonymized Magic Voice-style evaluation set recording distinct-document recall at 5 and 10,
mean reciprocal document rank, no-answer false-positive rate under a documented policy, and p50/p95
latency. The existing compact corpus remains a regression suite, not production evidence.

## Phase 4: versioned lightweight catalog

Add a generic `list_document_catalog` tool backed by a document application service. It returns
only fields needed to choose a document:

```json
{
  "corpusVersion": "generation:42",
  "items": [
    {
      "id": "doc_...",
      "revisionId": "rev_...",
      "title": "Build a Raised Garden Bed",
      "sourcePath": "scraped_articles_garden/...md",
      "metadata": { "documentType": "project_guide" }
    }
  ],
  "nextCursor": "..."
}
```

The catalog supports `status`, `collection_id`, metadata filters, and field projection from a fixed
allowlist. `corpusVersion` changes when a live document is created, updated, made ready, failed, or
deleted. A request supplying the current version may return `unchanged: true` without items.

Document type comes from ingestion metadata, frontmatter, or an import manifest. MCP Knowledge does
not infer application-specific types from filenames. Existing `list_documents` remains available.
Magic Voice prefers `metadata.documentType` and retains filename classification during rollout.

## Error behavior

- Tool errors continue to use MCP `isError: true` responses.
- Invalid scalar types, enums, and ranges return stable public error codes rather than raw SQL or
  JavaScript errors.
- Fetch cursors never expose storage keys or alterable cross-document offsets.
- Search and fetch remain read-only under the existing API-key read scope.
- An optional lexical-fallback failure does not hide successful exact/vector results; it is logged
  and available results are returned.

## Testing

### Unit tests

- Numeric argument bounds and type rejection.
- Search expansion schema and mapping.
- Chunk neighbor mapping and caps.
- Block pagination, heading selection, character ceilings, stale/tampered cursors, and one
  oversized block.
- Deterministic document collapse and matched-heading summaries.
- Exact lexical pass, fallback threshold, stop words, identifiers, and title weighting.
- Corpus-version changes for relevant document lifecycle transitions.

### Integration tests

- MCP tool schemas advertise every supported field.
- Existing requests receive compatible shapes.
- A normalized document larger than 32,000 characters can be read across valid pages and rebuilt.
- Search expansion and `get_chunk` return ordered context.
- Collapsed search returns distinct documents when one document has many matching chunks.
- Catalog pagination is complete and version checks suppress unchanged payloads.

### Consumer tests

In Magic Voice, prove that:

- Project Loader accepts a paged guide;
- a guide spanning pages is assembled once and memoized;
- explicit document metadata wins over filename fallback;
- Ask consumes collapsed hits without its current deduplication workaround.

## Rollout and compatibility

- Ship additive schemas first; old clients continue sending existing requests.
- Magic Voice feature-detects new arguments and tool names from `tools/list` and retains current
  behavior against older images.
- Deploy pagination before lowering any document-size limit.
- Keep chunk-mode search as the default. Enable document collapse explicitly in Magic Voice,
  observe traces, and reserve any default change for a major version.
- Record the MCP Knowledge image digest used by Magic Voice so retrieval changes can roll back
  independently.

## Explicitly deferred

- A cross-encoder or hosted reranker.
- Answer generation in MCP Knowledge.
- Home Depot-specific schemas or filename rules.
- Unbounded full-document MCP responses.
- Changing the embedding model or chunking constants.
