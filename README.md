<div align="center">

# Document Knowledge

**Give your documents a card catalog, not a black box.**

Self-hosted document search over MCP and REST. Ingest PDFs, docs, and pages;
get back explainable hybrid retrieval — every hit traceable to its vector
rank, lexical rank, and fusion score.

### 🔑 No API key. No hosted AI. Ever.

Embeddings run locally on a vendored model — not a proxy, not a "bring your
own key" screen. `docker compose up -d` and it works, offline, before you've
typed a single credential.

[**Live overview →**](https://raysca.github.io/mcp-knowledge/) ·
[Quick start](#quick-start) ·
[MCP setup](#mcp) ·
[Docs](#supporting-docs)

[![License: MIT](https://img.shields.io/badge/license-MIT-3d5a80.svg)](LICENSE)
[![Build](https://github.com/raysca/mcp-knowledge/actions/workflows/docker.yml/badge.svg)](https://github.com/raysca/mcp-knowledge/actions/workflows/docker.yml)
![Platforms](https://img.shields.io/badge/platforms-linux%2Famd64%20%7C%20linux%2Farm64-3d5a80)
![No API key required](https://img.shields.io/badge/API%20key-not%20required-2e7d32)

</div>

---

## Why not just use X?

|  | **Document Knowledge** | Hosted RAG APIs<br/>(OpenAI Assistants, etc.) | LangChain / LlamaIndex | Self-hosted "chat with docs" apps |
| --- | :---: | :---: | :---: | :---: |
| Needs a paid LLM API key | **No** | Yes | Usually | Usually |
| MCP-native endpoint | **Yes** | No | DIY | Rare |
| Explainable ranking (vector + lexical + fusion score, per hit) | **Yes** | No | DIY | Rare |
| Runs as one container | **Yes** | N/A — hosted | No — you assemble the stack | Usually several services |
| Broad format support out of the box | **Yes** (via AnyDoc) | Varies | DIY | Varies |
| Your documents never leave your machine | **Yes** | No | Depends how you wire it | Usually |

It's not that the alternatives are bad — a hosted API is faster to a demo,
and LangChain/LlamaIndex are more flexible if you're building something
bespoke. This is for when you want the retrieval *service* already built,
running on your own hardware, with nothing to sign up for.

## How it works

```mermaid
flowchart LR
    subgraph In[" "]
        direction TB
        U[Upload]
        L[Watched folder]
        R[URL]
    end
    In --> P["Parse<br/>AnyDoc + native text"]
    P --> C["Chunk &amp; embed<br/>local MiniLM, worker thread"]
    C --> D[("libSQL<br/>vector + FTS5, one file")]
    D --> H{"Hybrid search<br/>Reciprocal Rank Fusion"}
    H --> REST[REST API]
    H --> MCP[MCP]
    H --> UI[Dashboard]
```

Parsing runs in a spawned subprocess and embedding in a worker thread, so a
hostile or malformed upload can't take the serving process down. Nothing in
this pipeline calls out to a hosted model.

## Any format you throw at it

Document parsing is powered by [AnyDoc](https://github.com/firecrawl/anydoc),
the same document-conversion engine behind Firecrawl — so Word, PowerPoint,
Excel, CSV, PDF, OpenDocument, RTF, and EPUB files are all handled by one
battle-tested native parser instead of a pile of format-specific hacks.
Native HTML, Markdown, JSON, XML, and plain text are parsed directly without
AnyDoc at all. Drop in a `.zip` and every allowlisted file inside it gets
extracted and ingested the same way. See
[docs/supported-formats.md](docs/supported-formats.md) for the full list and
size limits.

## Why this exists

Most "chat with your docs" tools hand you a paragraph and a shrug. This one
treats every search result like a library index card: where it came from,
why it ranked where it did, and which retrieval method actually found it.
Run it entirely on your own hardware — the embeddings are local, the
database is a single file, and nothing leaves your machine unless you tell
it to.

- **Explainable, not a black box.** Vector rank, lexical rank, and the fused
  score ship with every hit, over both REST and MCP.
- **MCP-native.** A Streamable HTTP MCP endpoint sits next to the REST API on
  the same origin — point Claude, Cursor, or any MCP client at it directly.
- **One container, one process.** `Bun.serve()` handles the dashboard, REST,
  and MCP together; libSQL and the local filesystem hold everything.
- **A real recovery story.** Originals are canonical; every chunk and
  embedding can be rebuilt from them. Backup and restore are documented, not
  promised.

Not sure this is what you're looking for? See [What this is not](#what-this-is-not).

## Contents

- [Why not just use X?](#why-not-just-use-x)
- [How it works](#how-it-works)
- [Any format you throw at it](#any-format-you-throw-at-it)
- [Prerequisite](#prerequisite)
- [Quick start](#quick-start)
- [First upload and search](#first-upload-and-search)
- [MCP](#mcp)
- [Exposing beyond loopback](#exposing-beyond-loopback)
- [Import a local directory on startup](#import-a-local-directory-on-startup)
- [Persistence, recovery, and removal](#persistence-recovery-and-removal)
- [What this is not](#what-this-is-not)
- [Supporting docs](#supporting-docs)
- [Contributor workflow](#contributor-workflow-local-checkout-no-docker)

## Prerequisite

Docker Engine or Docker Desktop with Compose. Nothing else needs to be
installed on the host — Bun, the parser, and the embedding model are all
inside the image.

## Quick start

```bash
docker compose up -d
```

This builds the image, starts one container bound to `127.0.0.1:3000`, and
creates a named volume (`mcp-knowledge-data`) that holds everything —
database, document originals, embeddings. Wait for it to report healthy:

```bash
docker compose ps
curl --fail http://127.0.0.1:3000/health
```

With no `DASHBOARD_PASSPHRASE` set, the instance has no auth at all — the
dashboard, REST API, and MCP endpoint all just work on loopback. That's fine
for a service only your own machine can reach; see
[Exposing beyond loopback](#exposing-beyond-loopback) before putting this
anywhere else can reach it.

## First upload and search

Open `http://127.0.0.1:3000` for the dashboard, or use the API directly:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/documents \
  -F "file=@/path/to/a/document.pdf"

curl -sS -X POST http://127.0.0.1:3000/api/v1/search \
  -H 'content-type: application/json' \
  -d '{"query":"a phrase from the document","mode":"hybrid","limit":8}'
```

Poll `GET /api/v1/documents/:id` or watch the Jobs page until the document
reaches `ready`. The dashboard's `/playground` page lets you try hybrid,
vector, and lexical search side by side and inspect why each result ranked
where it did. Uploading a `.zip` extracts and ingests every allowlisted file
inside it. See [docs/supported-formats.md](docs/supported-formats.md) for
accepted file types and size limits.

## MCP

Dashboard, REST, and MCP share the same `Bun.serve()` process and port — the
MCP endpoint is `/mcp` (Streamable HTTP). MCP tools are read-only
(`search_documents`, `get_document`, `get_chunk`, `list_documents`,
`list_collections`); use the REST API to upload or manage documents.

```json
{
  "mcpServers": {
    "knowledge": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <secret>"
      }
    }
  }
}
```

If no `DASHBOARD_PASSPHRASE` is set, omit the `Authorization` header entirely.

### Generate an API key

API keys are for MCP clients and scripts — separate from the dashboard's
passphrase/session. Once a passphrase is set, minting a key requires either
an active dashboard session or an existing `admin` key:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/api-keys \
  -H 'content-type: application/json' \
  -b 'mk_session=<value from the dashboard login response>' \
  -d '{"name":"local","scopes":["admin"]}'
```

The response includes `secret` once (a `key_…` string); only a hash is
stored afterward. Omit `scopes` to get `read`. Allowed scopes: `read`,
`write`, `admin`.

```bash
curl -sS http://127.0.0.1:3000/api/v1/documents \
  -H "Authorization: Bearer <secret>"
```

Empty the corpus: `POST /api/v1/documents/purge` with `{ "confirm": "purge" }`.
Collections and API keys stay.

## Exposing beyond loopback

**Set `DASHBOARD_PASSPHRASE` before making this reachable from anywhere but
`127.0.0.1`** — a LAN address, a reverse proxy, a tunnel:

```bash
DASHBOARD_PASSPHRASE=correct-horse-battery-staple docker compose up -d
```

Opening the dashboard now prompts for the passphrase. On success the server
sets an `HttpOnly`, `SameSite=Strict` session cookie (`mk_session`, 30 days).
Logging in also unlocks `/api/v1/*` for that browser session, so you can mint
your first API key from the dashboard itself. Wrong-passphrase attempts are
rate-limited per remote address.

There is no network-position exception anywhere in auth — a passphrase is
checked the same way regardless of who's asking or how they connect, which is
what makes it safe to put a real reverse proxy in front. See
[SECURITY.md](SECURITY.md) for the full model, including URL-ingest SSRF
protections and backup sensitivity.

## Import a local directory on startup

Set `INGEST_DATA_DIR` to scan one local directory in the background after the
server starts:

```yaml
# compose.yaml
environment:
  INGEST_DATA_DIR: /import
volumes:
  - ./knowledge:/import:ro
```

`INGEST_DATA_MAX_DEPTH` defaults to `8` (`0` means root files only) and
`INGEST_DATA_MAX_FILES` defaults to `10000`. Missing files do not remove
documents; changed and renamed scanner-owned files replace the prior
document. A `.zip` found by the scan is extracted the same way a manually
uploaded one is. Progress appears on the Jobs page. URL ingest works the same
way on demand: `POST /api/v1/documents/from-url` with `{ "url": "https://..." }`
(loopback, RFC1918, link-local, and cloud-metadata targets are blocked,
including through redirects).

## Persistence, recovery, and removal

Everything lives in the `mcp-knowledge-data` volume. Restarting or rebuilding
the container preserves it:

```bash
docker compose restart
docker compose down      # keeps the volume
docker compose down -v   # deletes it — irreversible
```

For an offline backup or disaster recovery onto a fresh volume, see
[docs/backup-and-restore.md](docs/backup-and-restore.md). Every derived
artifact (normalized text, chunks, embeddings) can be rebuilt from the stored
original via reindex; the original itself is what backup and restore protect.

## What this is not

Not a chat app, not an agent framework, not a general document-management
system. No hosted AI dependency, no multi-tenancy, no distributed deployment
in v0.1 — see [CHANGELOG.md](CHANGELOG.md) for the full list of what's
deliberately out of scope for this release.

## Supporting docs

- [docs/supported-formats.md](docs/supported-formats.md) — accepted file
  types, OCR/password behavior, size and resource limits.
- [docs/troubleshooting.md](docs/troubleshooting.md) — every ingestion
  failure code, what it means, and how to recover.
- [docs/backup-and-restore.md](docs/backup-and-restore.md) — offline backup
  and disaster recovery.
- [docs/performance.md](docs/performance.md) — reference scale measurements
  at 100/500/1,000 documents.
- [docs/container-release.md](docs/container-release.md) — how the
  multi-architecture image is built, tested, and published.
- [SECURITY.md](SECURITY.md) — exposure model, SSRF boundary, and how to
  report a vulnerability.
- [CHANGELOG.md](CHANGELOG.md) — what's in 0.1.0 and what's deliberately not.

## Contributor workflow (local checkout, no Docker)

```bash
bun install
bun db:migrate
bun dev
```

Dashboard, REST, and MCP share one `Bun.serve()` process (default
`http://127.0.0.1:3000`). Before committing:

```bash
bun run typecheck
bun test
```

`bun run release:check` runs the full release gate (typecheck, tests, CSS
build, Compose validation, both-platform Docker smoke, scale-report
validation) — the same gate `v0.1.0` was tagged against.

## License

[MIT](LICENSE) © Raymond Ottun
