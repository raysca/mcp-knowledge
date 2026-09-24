# Changelog

## Unreleased

- Added a versioned, paginated document catalog through REST
  (`GET /api/v1/document-catalog`) and MCP (`list_document_catalog`), with
  safe field projections, status/collection/metadata filters, and conditional
  refresh. Clients compare versions across pages and restart on a change.
- Added a root-only `.mcp-knowledge-manifest.json` for directory scans. Ordered
  safe glob rules attach metadata, and manifest changes replace affected
  scanner-owned documents on restart. The scanner remains authoritative for
  `sourcePath`; rules do not apply to extracted ZIP members.
- Added opt-in `collapse: "document"` to MCP and REST search. It returns one
  representative best chunk per document, document ranks, candidate-based
  `matchingChunkCount`, and unique `matchedHeadings`; bounded candidate pools
  can yield fewer documents than requested. Chunk results remain the default.
- Added title-aware lexical indexing and an exact-first spoken-query fallback.
  Fallback uses a static English stop-word set and requires two matching terms
  when at least three are eligible; standalone identifiers retain all-terms
  matching. Optional fallback failures preserve available retrieval results.
- Added anonymized spoken/document retrieval regression cases on the existing
  15 generic fixtures, distinct-document recall@5/@10 and MRR, and an explicit
  any-returned-document no-answer false-positive policy. Reports retain latency
  p50/p95 and existing fields. Hybrid retrieval does not abstain (4/4 no-answer
  cases returned hits); lexical retrieval returned hits for 2/4. This compact
  evaluation is not production quality or latency evidence.
- `get_document` now returns block-safe, parseable JSON pages with opaque
  continuation cursors, bounded block limits, optional heading selection, and
  stable cursor and oversized-block error codes. Small document bodies retain
  their existing string format. Server deployments require an independent
  `DOCUMENT_CURSOR_SECRET` so cursors survive restarts.
- Documented MCP metadata filters, bounded search expansion, and `get_chunk`
  neighbor controls. `document` expansion remains REST-only, and MCP tool
  errors retain stable public codes.

## 0.1.0 - 2026-09-07

First Docker-first local release, for 100–1,000-document local corpora on
`linux/amd64` and `linux/arm64`.

### Capabilities

- Single-container deployment via `docker compose up`: Bun server, libSQL
  database, local filesystem blob store, all in one persistent volume.
- Ingests PDF, Word, PowerPoint, Excel, OpenDocument, EPUB, RTF, HTML, XML,
  JSON, CSV, Markdown, and plain text — see
  [docs/supported-formats.md](docs/supported-formats.md) for the exact list
  and size limits.
- Parsing runs in a spawned subprocess and embedding in a worker thread, so a
  hostile or malformed document cannot crash or stall the serving process.
- Hybrid retrieval (vector + lexical, Reciprocal Rank Fusion) over the REST
  API, MCP (Streamable HTTP), and a browser dashboard, all from one process
  and one origin. Every hit is explainable back to vector rank, lexical rank,
  and fusion score.
- Local embeddings only (`Xenova/all-MiniLM-L6-v2`, vendored) — no hosted AI
  dependency required to run.
- Passphrase-gated dashboard sessions and scoped API keys (`read`/`write`/
  `admin`) for MCP clients and scripts.
- SSRF-safe URL ingest and background local-directory ingest
  (`INGEST_DATA_DIR`).
- Documented offline backup/restore of the whole data volume and job-recovery
  behavior across restarts — see
  [docs/backup-and-restore.md](docs/backup-and-restore.md).
- Safe, actionable ingestion failure codes shown in the dashboard — no
  parser output, paths, or stack traces ever surface to a user; see
  [docs/troubleshooting.md](docs/troubleshooting.md).
- Reference scale measurements at 100/500/1,000 documents — see
  [docs/performance.md](docs/performance.md).

### Known limitations

Not available in 0.1.0 — these are unavailable, not partially built:

- PostgreSQL or S3 backends (`APP_PROFILE=server` is an architectural target,
  not a supported v0.1 profile).
- Distributed or multi-node deployment, Kubernetes.
- Multi-tenancy or workspaces (single-tenant only).
- Hosted OCR or hosted embedding/AI providers.
- Webhooks (poll `GET /api/v1/documents/:id` or the Jobs page instead).
- Reranking, chat/agent features, or continuous filesystem watching.
- A dedicated `explain_search` MCP tool (use
  `POST /api/v1/search/explain`, or the `ranking` object already on every
  search hit).
- Built-in TLS termination or rate limiting beyond login attempts — see
  [SECURITY.md](SECURITY.md) before exposing beyond loopback.
