# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repository currently contains **only planning documents** — no source code, no `package.json`, no git history yet:

- `Document Knowledge MCP Service — Technical & Product Specification.md` — the authoritative spec. Read it before writing any code; it defines schemas, interfaces, API shapes, and constants that implementation must match exactly (env var names, default limits, error codes, ID prefixes, etc.).
- `docs/superpowers/plans/2026-08-29-document-knowledge-mcp-go-live.md` — go-live implementation plan (milestones M0–M11, Gate A local / Gate B production). Execute this, not the older `.docx`. It deliberately narrows a few things the spec leaves open-ended — see "Where the plan narrows the spec" below.
- `document-knowledge-mcp-implementation-plan.docx` — earlier draft; superseded by the markdown plan above.

There are no build/lint/test commands yet because there is no project scaffolding. When the project is bootstrapped, it will be a Bun + TypeScript monorepo (see §6/§113 of the spec) with `bun install`, `bun db:migrate`, `bun dev` as the core workflow, and `bun test` for unit/integration tests (§117).

## What this project is

A self-hostable "Document Knowledge MCP Service": ingest arbitrary documents, chunk and embed them locally, and expose explainable hybrid (vector + lexical) retrieval over both MCP and a REST API. Positioned as infrastructure, not a chat app or agent framework (spec §3, §127 lists explicitly deferred features — don't build those unless asked).

## Core architectural rules (non-negotiable per spec)

These are the constraints most likely to be violated by a generic implementation — check the spec before deviating:

1. **MCP is a thin adapter, never the architecture.** MCP, HTTP, and the UI all sit on top of the same application services; MCP tools must not contain parsing/DB/chunking/embedding logic (§4.1, §62–71).
2. **Originals are canonical; everything else is rebuildable.** Normalized docs, chunks, embeddings, and indexes must be derivable again from the stored original (§4.2).
3. **Infrastructure is behind interfaces**, swappable per deployment profile — `BlobStore`, `KnowledgeRepository`, `VectorIndex`, `Embedder`, `DocumentParser` (§4.3, §32–33, §43, §15). Never let AnyDoc types leak outside `packages/parser/adapters/anydoc`.
4. **Zero required external AI dependency.** No OpenAI/Anthropic/Cohere/hosted embeddings by default; embeddings run locally via `@huggingface/transformers` + vendored `Xenova/all-MiniLM-L6-v2` ONNX model (384-d, §27–29). Hosted OCR is explicitly disabled by default (§5, §15.2).
5. **One HTTP server, one process.** `Bun.serve()` only — no Express/Hono/Elysia/Next.js, no second HTTP server for the dashboard, no Vite. The React+shadcn+Tailwind dashboard is bundled by Bun and served same-origin from the same process (§5, §72, §113).
6. **Single-tenant in v1.** No `workspaceId` column, no workspace path/header, no dummy "default" workspace row (§8).
7. **Retrieval must stay explainable**, never a black box — every hit should be traceable to vector rank, lexical rank, fusion score, and source location (§4.5, §38–39, §75–76).
8. **Dependency direction**: HTTP/MCP/UI → application services → domain → interfaces → adapters. Never import an adapter from application code the other way (§124).

## Key fixed values (don't invent alternatives)

- Retrieval: hybrid = vector + lexical fused with **Reciprocal Rank Fusion**, `k=60`, 50 candidates per side by default (§34–36).
- Lexical: libSQL FTS5 / Postgres `tsvector` with `simple`/`unicode61` tokenizers — **no stemming** (breaks SKUs/error codes) (§34).
- Chunking: target 180 / min 64 / max 220 tokens, 32 overlap, bounded by the embedding model's 256-token limit; boundaries prefer heading → paragraph → table → list → sentence → token (§21).
- Chunk/document/job IDs are prefixed UUIDv7 strings (`doc_`, `rev_`, `chk_`, `col_`, `job_`, `key_`, `wh_`, `evt_`, `req_`) — see §110 for the full table.
- Deployment profiles: `APP_PROFILE=local` (libSQL, local filesystem, embedded worker) vs `APP_PROFILE=server` (Postgres, S3, distributed-safe job locking) — same application code, different config (§94–95).
- Jobs use the database itself as the durable queue (`SELECT ... FOR UPDATE SKIP LOCKED` / libSQL `BEGIN IMMEDIATE`), no Redis (§19).
- Resource limits, timeouts, and error codes are enumerated precisely in §98 and §15.2 — reuse those names/values (e.g. `MAX_UPLOAD_BYTES=67108864`, `DOCUMENT_NEEDS_OCR`) rather than inventing new ones.

## Suggested repo layout

See spec §6 for the full recommended monorepo layout (`apps/server`, `packages/core`, `packages/db`, `packages/parser`, `packages/embeddings`, `packages/storage`, `packages/retrieval`, `packages/sdk`) and the go-live plan's milestone order (M0 spikes → M1 foundation → M2 ingestion → M3 embeddings → M4 hybrid retrieval → M5 MCP + URL ingest → **Gate A** → M6 playground / M7 Postgres / M8 S3 / M9 observability → M11 production cut → **Gate B**). Follow that order when implementing incrementally — each milestone has its own exit criteria.

## Where the plan narrows the spec

The go-live plan trims a handful of spec areas that are correct as a target architecture but speculative to build before v1 has a real consumer. When code and spec disagree here, **the go-live plan wins**:

- **Webhooks (spec §86–91) are post-v1**, not part of Gate A or Gate B. Poll `GET /api/v1/documents/:id` or the jobs dashboard instead. Pick the milestone back up only when a real integration needs push delivery.
- **No `explain_search` MCP tool.** It would duplicate `POST /api/v1/search/explain` and the `ranking` object already on every search hit; MCP clients follow the resource URI to the HTTP endpoint instead.
- **API key scopes are `read` / `write` / `admin`**, not spec §97's nine per-resource scopes. Split further only if a real multi-key deployment needs it.
- **`/metrics` ships 4 series for v1** (`documents_total`, `documents_failed_total`, `job_queue_depth`, `search_duration_seconds`), not all ~20 named in spec §82. Add a series when an operator asks a question it would answer.
- **Reindex-stale is a log line on manual reindex**, not spec §104–105's proactive dashboard banner — no second parser/chunker/embedding version has shipped yet to justify one.
- **SSRF blocklist for URL ingest (§100) has no configurable override.** It's hardcoded; don't add an allow-list knob to this boundary.
