# Changelog

## 0.1.0

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
