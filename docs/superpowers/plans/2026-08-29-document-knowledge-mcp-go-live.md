# Document Knowledge MCP — Go-Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-hostable document knowledge service that ingests files, indexes them locally, and exposes explainable hybrid retrieval over MCP and HTTP — first as a one-command local product, then as a Dockerized Bun + Postgres + S3 service.

**Architecture:** One `Bun.serve()` process owns REST (`/api/v1`), MCP (`/mcp`), and a React/shadcn dashboard (`/`). Application services sit on domain types and interfaces; adapters (libSQL/Postgres, local/S3, AnyDoc, MiniLM) swap by `APP_PROFILE`. Original blobs are canonical; chunks, embeddings, and indexes are rebuildable. MCP is a thin adapter and must not parse, chunk, or embed.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, libSQL then Postgres/pgvector, `@firecrawl/anydoc`, `@huggingface/transformers` + vendored `Xenova/all-MiniLM-L6-v2` (384-d uint8 ONNX), React + shadcn/ui + Tailwind (Bun-bundled, no Vite).

**Spec:** [`Document Knowledge MCP Service — Technical & Product Specification.md`](../../../Document%20Knowledge%20MCP%20Service%20—%20Technical%20&%20Product%20Specification.md) is authoritative. Do not invent alternate IDs, env names, error codes, or limits.

## Global Constraints

- Runtime: Bun + TypeScript. HTTP: `Bun.serve()` only — no Express, Hono, Elysia, Next.js, Vite, or a second UI server.
- UI: React + shadcn/ui + Tailwind in `apps/server/src/ui`, same origin, relative `/api/v1` calls.
- Tenancy: single-tenant. No `workspaceId`, no workspace header, no dummy default workspace.
- IDs: prefixed UUIDv7 (`col_`, `doc_`, `rev_`, `chk_`, `job_`, `key_`, `wh_`, `evt_`, `req_`).
- Embeddings: `Xenova/all-MiniLM-L6-v2`, 384-d, uint8 ONNX, `allowRemoteModels = false`, max 256 tokens. Chunk defaults 180 / 64 / 220 / 32 using that WordPiece tokenizer.
- Parser: `@firecrawl/anydoc` via `toDocument()` mapped to `NormalizedDocument`. Hosted OCR off. `needsOcr` → `DOCUMENT_NEEDS_OCR`. AnyDoc types stay inside `packages/parser/adapters/anydoc`.
- Retrieval: hybrid = 50 vector + 50 lexical, RRF `k=60`, then cut to `limit` (default 8). Lexical: FTS5 `unicode61` / Postgres `simple` — no stemming.
- Jobs: database queue. Postgres `FOR UPDATE SKIP LOCKED`; libSQL `BEGIN IMMEDIATE`. Lease 5 minutes (`JOB_LEASE_MS=300000`).
- Process isolation (ponytail review 2026-08-29, not optional): AnyDoc `parse()` always runs in a spawned subprocess (M2 Step 2), never inline in the server process — a native-addon crash on a hostile file must not take down the HTTP/MCP server. MiniLM inference always runs in a `Worker` thread (M3 Step 1), never on the main loop — it must not stall in-flight requests.
- Limits: `MAX_UPLOAD_BYTES=67108864`, `MAX_EXTRACT_BYTES=8388608`, `MAX_DOCUMENT_PAGES=500`, `MAX_SPREADSHEET_CELLS=200000`, `PARSER_TIMEOUT_MS=30000`, `INGESTION_TIMEOUT_MS=600000`. Upload 413 on oversize.
- Duplicate SHA-256 of a live document: return existing with `duplicate: true`.
- Zero required external AI. No chat UI, agents, SSO, or rerankers (spec §127).
- Dependency direction: HTTP/MCP/UI → services → domain → interfaces → adapters.
- Tests: `bun test`. Do not commit secrets or downloaded model caches outside `models/default/`.

---

## Go-live gates

Two ship points. Do not call the product “live” after M1.

| Gate | After | What a user can do | Deploy |
| --- | --- | --- | --- |
| **A — Local live** | M5 | Upload → wait ready → search via dashboard, HTTP, and MCP; inspect why a chunk matched | `bun dev` / one Docker image, libSQL, local disk |
| **B — Production live (v1)** | M11 | Same, plus playground, Postgres, S3, metrics, URL ingest, server profile | Docker, `APP_PROFILE=server` |

SDK (`packages/sdk`) is explicitly v1.5 — **not** on the go-live path.

**Also v1.5, per ponytail review 2026-08-29 (build when a real consumer needs it, not speculatively):**
- Webhooks (was M10) — no known consumer yet. Poll `GET /api/v1/documents/:id` / the jobs dashboard for `ready`/`failed` in v1.
- `explain_search` MCP tool — duplicates `POST /api/v1/search/explain` and the `ranking` field already on every hit. MCP clients needing the full breakdown call the HTTP endpoint via the resource URI.
- Proactive "reindex recommended" dashboard banner — no second parser/chunker/embedding version has ever shipped yet. `POST /api/v1/documents/:id/reindex` logs the version delta when triggered; add the banner once that's a real papercut.

---

## File map

Create this layout in M0–M1. Later milestones fill packages; they do not invent a second app.

```text
/
├── apps/server/
│   ├── src/
│   │   ├── index.ts                 # Bun.serve: UI + /api/v1 + /mcp + /health
│   │   ├── config/env.ts            # typed env, APP_PROFILE defaults
│   │   ├── http/                    # router, error envelope, multipart, requestId
│   │   ├── mcp/                     # Streamable HTTP adapter only
│   │   ├── workers/loop.ts          # claim → process → complete/fail
│   │   └── ui/                      # React + shadcn, bundled by Bun
│   ├── components.json
│   └── package.json
├── packages/
│   ├── core/                        # services + domain types, no adapters
│   ├── db/                          # Drizzle schema + libsql + postgres
│   ├── parser/                      # DocumentParser + anydoc + native-text
│   ├── embeddings/                  # Embedder + MiniLM
│   ├── storage/                     # BlobStore + local + s3
│   └── retrieval/                   # vector, lexical, hybrid, RRF
├── drizzle/                         # SQL migrations (FTS, vector)
├── models/default/                  # vendored MiniLM snapshot (M3)
├── tests/
│   ├── unit/
│   ├── integration/
│   └── retrieval/                   # fixed corpus + Recall@K (M4)
├── package.json                     # bun workspaces
└── bun.lock
```

**Workspaces:** `apps/*` and `packages/*` in the root `package.json`. One `bun.lock`.

---

## Milestone overview

| ID | Name | Depends | Est. (1 engineer) | Gate |
| --- | --- | --- | --- | --- |
| M0 | Spikes + repo | — | 1–2 d | |
| M1 | Foundation | M0 | 4–6 d | |
| M2 | Ingestion | M1 | 5–7 d | |
| M3 | Embeddings | M2 | 3–4 d | |
| M4 | Hybrid retrieval | M3 | 4–5 d | |
| M5 | MCP + URL ingest | M4 | 3–4 d | **A Local live** |
| M6 | Playground | M5 | 3–4 d | |
| M7 | Postgres | M4 | 4–5 d | can overlap M6 |
| M8 | S3 | M7 | 2–3 d | |
| M9 | Observability | M5 | 3–4 d | can overlap M6–M8 |
| M11 | Production cut | M6–M9 | 3–4 d | **B Production live** |

Webhooks are cut from the go-live path (see Go-live gates) — pick them back up as a post-v1 milestone if a real consumer shows up.

Calendar: Gate A ~ **4–6 weeks**, Gate B ~ **6–8 weeks**, assuming spikes pass and no parser/embed Bun blockers.

```text
M0 → M1 → M2 → M3 → M4 → M5 ──┬── M6 ──┐
                               ├── M7 → M8 ┼→ M11
                               └── M9      │
```

---

### Milestone 0: Spikes and repository

**Goal:** Prove AnyDoc and MiniLM load under Bun; create the workspace so M1 is coding, not research.

**Files:**
- Create: `apps/server/package.json`, `packages/*/package.json`, root `package.json`, `tsconfig.json`, `.gitignore`
- Create: `scripts/spike-anydoc.ts`, `scripts/spike-embed.ts`
- Create: `README.md` (dev commands only)

**Produces:** Decision record in `docs/spikes/bun-native.md`: N-API vs WASM for AnyDoc; Transformers.js vs fallback for MiniLM.

- [x] **Step 1: Init Bun workspaces**

Root `package.json` workspaces `["apps/*", "packages/*"]`. `packageManager` bun. TypeScript `strict`. `.gitignore`: `node_modules`, `data/`, `.env`, `*.db`, `dist/`.

```bash
bun init
```

- [x] **Step 2: AnyDoc spike**

```ts
import { toDocument } from "@firecrawl/anydoc";
const bytes = await Bun.file("scripts/fixtures/hello.docx").arrayBuffer();
const doc = await toDocument(new Uint8Array(bytes));
if (!doc.blocks?.length) throw new Error("empty anydoc document");
console.log("anydoc ok", doc.blocks.length);
```

Run: `bun scripts/spike-anydoc.ts`

Expected: prints a block count. If N-API fails, retry `@firecrawl/anydoc-wasm`. Write the winner into `docs/spikes/bun-native.md`. **Do not enable `ocr: "hosted"`.** Also confirm `Bun.spawn(["bun", "run", "scripts/spike-anydoc.ts"])` from a second script can pipe the same fixture over stdin/stdout — M2 Step 2 requires this call pattern to work under Bun, not just the bare library call.

- [x] **Step 3: MiniLM spike**

```ts
import { env, pipeline } from "@huggingface/transformers";
env.allowRemoteModels = false;
env.localModelPath = "./models/default";
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
  local_files_only: true,
});
const out = await extractor("hello world", { pooling: "mean", normalize: true });
const vec = Array.from(out.tolist()[0] as number[]);
if (vec.length !== 384) throw new Error(`dims ${vec.length}`);
console.log("embed ok", vec.length);
```

Vendor the uint8 ONNX snapshot into `models/default/` **before** this run (no network). If Transformers.js fails on Bun, document the fallback (`onnxruntime-node` + same ONNX file) in the spike note. Also confirm the same `pipeline()` call works when loaded inside `new Worker(...)` and reachable via `postMessage` — M3 Step 1 requires this, not just the bare main-thread call. Gate M3 on this result.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock apps packages scripts docs/spikes .gitignore tsconfig.json
git commit -m "chore: monorepo skeleton and Bun AnyDoc/MiniLM spikes"
```

**Exit:** Both spikes pass on the implementation machine. Spike note names the exact packages used.

---

### Milestone 1: Foundation (local live skeleton)

**Goal:** `bun dev` serves a dashboard and API. A user can upload a file, see it listed, download it, and delete it. No parse/embed yet; status stays `pending`.

**Files:**
- Create: `packages/core/src/ids.ts`, `packages/core/src/errors.ts`, `packages/core/src/domain/*.ts`
- Create: `packages/db/src/schema/libsql/*.ts`, `drizzle/0001_init.sql`
- Create: `packages/storage/src/blob-store.ts`, `packages/storage/src/local.ts`
- Create: `packages/core/src/services/document-service.ts`, `collection-service.ts`
- Create: `apps/server/src/config/env.ts`, `http/router.ts`, `http/errors.ts`, `index.ts`
- Create: `apps/server/src/ui/**` (Documents + Collections pages)
- Test: `tests/unit/ids.test.ts`, `tests/integration/documents-api.test.ts`

**Interfaces:**

```ts
function newId(prefix: "col" | "doc" | "rev" | "chk" | "job" | "key" | "wh" | "evt" | "req"): string
// e.g. doc_01J7Z3K...

type ErrorBody = { error: { code: string; message: string; requestId: string } }

interface BlobStore {
  put(key: string, data: Blob): Promise<void>;
  get(key: string): Promise<Blob>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

interface KnowledgeRepository {
  createDocument(...): Promise<Document>;
  getDocument(id: string): Promise<Document | null>;
  listDocuments(q: { collectionId?: string; status?: string; cursor?: string; limit: number }): Promise<{ items: Document[]; nextCursor?: string }>;
  softDeleteDocument(id: string): Promise<void>;
  // remaining methods land in M2
}
```

Storage keys: `documents/{documentId}/revisions/{revisionId}/original`

- [ ] **Step 1: IDs and errors**

Write `tests/unit/ids.test.ts`: prefix, sortability (UUIDv7 time component), uniqueness. Implement `newId`. Error helper returns `{ error: { code, message, requestId } }` with no stack in production.

- [ ] **Step 2: Env**

`loadEnv()` reads `APP_PROFILE` (default `local`). Local defaults: `DATABASE_DRIVER=libsql`, `DATABASE_URL=file:./data/app.db`, `STORAGE_DRIVER=local`, `STORAGE_PATH=./data/documents`, plus every `MAX_*` and timeout from spec §94/§98. Unknown `APP_PROFILE` throws at boot.

- [ ] **Step 3: Drizzle libSQL schema**

Tables from spec §122 **without** vector/FTS columns yet (those are M3/M4). Include `api_keys`, `collections`, `documents`, `document_revisions`, `document_chunks`, `ingestion_jobs`, `webhooks`, `webhook_deliveries`, `system_settings`. Partial unique on `documents.sha256 WHERE deleted_at IS NULL`. `bun db:migrate` applies `drizzle/0001_init.sql`.

- [ ] **Step 4: LocalBlobStore + DocumentService**

Upload path: sniff size → 413 if `> MAX_UPLOAD_BYTES` → SHA-256 → if live duplicate, return `{ ...existing, duplicate: true }` with **200** → else create document `pending`, revision 1, `put` original, enqueue nothing yet.

`POST /api/v1/documents` multipart field `file`, optional `collectionId`, `metadata`. Response `202` `{ id, status, revision }` (or 200 on duplicate). `GET /api/v1/documents`, `GET /api/v1/documents/:id`, `GET /api/v1/documents/:id/file`, `DELETE /api/v1/documents/:id` (soft delete; physical blob cleanup can be sync in M1, async in M2). Collections CRUD; `DELETE` collection while documents remain → `COLLECTION_NOT_EMPTY`.

- [ ] **Step 5: Bun.serve router**

One fetch handler: `/api/v1/*`, `/health` → `{ ok: true }`, `/` and `/assets/*` from the UI bundle. `X-Request-Id` in and out. Cursor pagination on lists (`limit` default 50, max `MAX_LIST_LIMIT=100`).

- [ ] **Step 6: Dashboard shell**

React + Tailwind + shadcn (Button, Table, Input, Dialog). Pages: Documents (upload, list, status, delete), Collections. `bun dev` = one port. No Vite config.

- [ ] **Step 7: Integration test**

`tests/integration/documents-api.test.ts`: upload tiny txt → list → get → download bytes match → delete → get 404/`DOCUMENT_NOT_FOUND`. Duplicate upload returns same `id` and `duplicate: true`. Oversize fixture returns 413.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat: upload, list, and delete documents on Bun.serve"
```

**Exit (M1 acceptance):** Upload, persist, list, delete from API and dashboard. `bun install && bun db:migrate && bun dev` is the whole loop.

---

### Milestone 2: Ingestion

**Goal:** Uploaded files become `NormalizedDocument` + chunks. Failures show in the dashboard and can be retried. Scanned PDFs fail `DOCUMENT_NEEDS_OCR`.

**Files:**
- Create: `packages/parser/src/types.ts`, `registry.ts`, `adapters/anydoc/*.ts`, `adapters/native-text/*.ts`
- Create: `packages/parser/src/anydoc/subprocess-runner.ts`, `packages/parser/src/anydoc/subprocess-entry.ts` (see Step 2 — parse isolation)
- Create: `packages/core/src/chunking/*.ts`, `packages/core/src/services/ingestion-service.ts`, `job-service.ts`
- Create: `apps/server/src/workers/loop.ts`
- Modify: `packages/db` job claim SQL (libSQL `BEGIN IMMEDIATE` from spec §19)
- Test: `tests/unit/chunking.test.ts`, `tests/unit/parser-map.test.ts`, `tests/integration/ingestion.test.ts`, `tests/integration/parser-crash.test.ts`

**Interfaces:**

```ts
interface DocumentParser {
  name: string;
  version: string;
  supports(input: { mimeType?: string; extension?: string }): boolean;
  parse(input: { data: Blob; filename: string; mimeType?: string }): Promise<NormalizedDocument>;
}

interface JobRepository {
  enqueue(input: { documentId: string; revisionId: string }): Promise<IngestionJob>;
  claim(workerId: string): Promise<IngestionJob | null>;
  complete(id: string): Promise<void>;
  fail(id: string, error: Error): Promise<void>;
}
```

- [ ] **Step 1: Native-text parsers**

TXT / Markdown / HTML / JSON / XML → `NormalizedDocument` blocks. Unit tests with fixtures. HTML can be a heading+paragraph walk; JSON/XML as a single `CodeBlock` if structure is opaque.

- [ ] **Step 2: AnyDoc adapter — parse in a subprocess, not the server process**

`toDocument` → map blocks (heading, paragraph, table **as TableBlock**, list, code, quote, image alt). Map errors: `unsupported` → `DOCUMENT_UNSUPPORTED_FORMAT`, `needsOcr` → `DOCUMENT_NEEDS_OCR`, `encrypted` → `DOCUMENT_ENCRYPTED`, `resourceLimit` → `DOCUMENT_RESOURCE_LIMIT`, `malformed`/`missingPart` → `DOCUMENT_MALFORMED`. `parserName: "anydoc"`, `parserVersion` from package.

**Architecture fix (was: spec §99 deferred process isolation to "later"; not deferrable — `@firecrawl/anydoc` is a native N-API addon parsing attacker-controlled bytes, and it was going to run inline in the same `Bun.serve()` process that answers HTTP/MCP. A crafted file that segfaults the addon takes down the whole server, not just one job.)**

Run every AnyDoc `parse()` call in a child process via `Bun.spawn`, never inline in the worker loop:

```ts
// packages/parser/src/anydoc/subprocess-entry.ts — the whole child process.
// Reads bytes from stdin, calls toDocument, writes NormalizedDocument JSON (or {error}) to stdout, exits.
import { toDocument } from "@firecrawl/anydoc";
const bytes = await Bun.stdin.bytes();
try {
  const doc = await toDocument(bytes);
  process.stdout.write(JSON.stringify({ ok: true, doc }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, code: (err as any).code, message: String(err) }));
}
```

```ts
// packages/parser/src/anydoc/subprocess-runner.ts — called from the worker, not from any HTTP handler.
export async function parseInSubprocess(bytes: Uint8Array, timeoutMs: number): Promise<NormalizedDocument> {
  const proc = Bun.spawn(["bun", "run", subprocessEntryPath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  // Start draining stdout/stderr BEFORE (not after) writing stdin. A large document's normalized-JSON
  // reply can exceed the OS pipe buffer; writing all of stdin first, then reading stdout, deadlocks —
  // child blocks writing its reply while parent is still blocked writing input. Same risk on stderr if
  // the native addon logs anything and nobody drains it. All three must run concurrently.
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text(); // drained, not surfaced unless exitCode !== 0
  const timeout = setTimeout(() => proc.kill(), timeoutMs); // enforces PARSER_TIMEOUT_MS
  await proc.stdin.write(bytes);
  await proc.stdin.end();
  const [out, stderrText, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new ParserError("DOCUMENT_MALFORMED", `anydoc subprocess exit ${exitCode}: ${stderrText.slice(0, 500)}`); // covers segfault/OOM-kill
  const result = JSON.parse(out);
  if (!result.ok) throw mapAnyDocError(result.code, result.message);
  return mapToNormalizedDocument(result.doc);
}
```

A segfault or OOM-kill in the child surfaces as a normal `DOCUMENT_MALFORMED` job failure — the API/MCP/UI in the parent process are unaffected and every other in-flight request keeps serving. Spawn-per-parse is the lazy version; add a warm subprocess pool only if spawn overhead shows up in ingestion-throughput numbers, not before. `tests/integration/parser-crash.test.ts` also needs a large-fixture case (near `MAX_DOCUMENT_PAGES`) asserting it completes well under `PARSER_TIMEOUT_MS`, not just the small-fixture crash case — that's the only way the deadlock above would show up in CI.

- [ ] **Step 3: Chunker**

Heading → paragraph → table → list → sentence → token. Token count = MiniLM WordPiece (load tokenizer only, or a vendored `tokenizers` JSON). Enforce 180/64/220/32. `embeddingText` = `Document: {title}\nSection: {headingPath}\n\n{content}` truncated so total tokens ≤ 256 (truncate body, keep heading prefix). Deterministic chunk id = hash(revision hash + heading path + normalized text). Persist `normalized.json` (and optional `normalized.md`) on the blob store.

- [ ] **Step 4: Worker loop**

On upload, `enqueue` job `queued`, document `processing`. Embedded worker in the server process (`WORKER_CONCURRENCY=1`). Claim SQL from spec. On success: chunks written, `chunk_count` set, document `ready`. On failure: `failed`, `latest_error` set, retry until `max_attempts`. Lease expiry reclaims `running`. `INGESTION_TIMEOUT_MS` kills the attempt. `MAX_EXTRACT_BYTES`, `MAX_DOCUMENT_PAGES`, `MAX_SPREADSHEET_CELLS`, `MAX_CHUNKS_PER_DOCUMENT` enforced.

- [ ] **Step 5: HTTP + UI**

`POST /api/v1/documents/:id/revisions`, `POST /api/v1/documents/:id/reindex`, `GET .../normalized`, `GET .../chunks`. Jobs page: queued/running/failed, retry. Document detail shows parser/chunker versions and error.

- [ ] **Step 6: Tests**

Fixture PDF/DOCX/MD. Assert chunk rows, `ready`. Encrypted or scanned PDF fixture → `DOCUMENT_NEEDS_OCR` or `DOCUMENT_ENCRYPTED` on the document. Retry endpoint re-enqueues. `tests/integration/parser-crash.test.ts`: a fixture that kills the subprocess (`process.exit(1)` stand-in, or an actual crafted crasher if AnyDoc has one) fails that job as `DOCUMENT_MALFORMED` while a concurrent `GET /health` and `GET /api/v1/documents` against the same running server both still return 200.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat: parse, chunk, and retry ingestion jobs"
```

**Exit:** Spec Phase 2 acceptance. Embeddings still absent; vector search is M3.

---

### Milestone 3: Local embeddings

**Goal:** Ingestion writes 384-d vectors. Vector KNN returns related chunks. No network, no GPU.

**Files:**
- Create: `packages/embeddings/src/embedder.ts`, `local-transformers.ts`
- Create: `packages/embeddings/src/worker-thread.ts` (see Step 1 — off-main-thread inference)
- Modify: `packages/db` add `embedding F32_BLOB(384)` + libSQL vector index (spec §122.3)
- Modify: worker to `embed(texts[])` in batches of `EMBEDDING_BATCH_SIZE=32`
- Create: `packages/retrieval/src/vector/libsql.ts`
- Test: `tests/unit/embedder.test.ts`, `tests/integration/vector-search.test.ts`, `tests/integration/embed-does-not-block-http.test.ts`

**Interfaces:**

```ts
interface Embedder {
  name: string;
  model: string;
  version: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

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

- [ ] **Step 1: Load once per worker — off the main thread**

**Architecture fix (was: `@huggingface/transformers` inference is synchronous CPU-bound JS/WASM math; Bun is single-threaded per isolate; the embedded worker loop shares the process with the HTTP server (spec §20). A batch of 32 chunks embedding mid-ingest would stall every in-flight search/API request on the same process — the spec's `search < 250ms` target (§119) is meaningless if a concurrent embed call is blocking the loop.)**

The `Embedder` pipeline runs inside a Bun `Worker` thread, not on the loop that serves HTTP. The worker (job-queue) process sends `embed(texts[])` requests to the thread over `postMessage` and awaits the reply; the HTTP server never touches the pipeline directly.

```ts
// packages/embeddings/src/worker-thread.ts — runs inside `new Worker(...)`, loaded once, pipeline reused.
import { env, pipeline } from "@huggingface/transformers";
env.allowRemoteModels = false;
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { local_files_only: true });
self.onmessage = async (e: MessageEvent<{ id: string; texts: string[] }>) => {
  const out = await extractor(e.data.texts, { pooling: "mean", normalize: true });
  postMessage({ id: e.data.id, vectors: out.tolist() });
};
```

```ts
// packages/embeddings/src/local-transformers.ts — implements Embedder, called from the ingestion worker loop.
export class LocalTransformersEmbedder implements Embedder {
  private worker!: Worker;
  private pending = new Map<string, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

  constructor() { this.spawn(); }

  private spawn() {
    this.worker = new Worker(new URL("./worker-thread.ts", import.meta.url));
    this.worker.onmessage = (e) => this.pending.get(e.data.id)?.resolve(e.data.vectors);
    // A crashed/unloadable pipeline must not silently hang every pending and future embed() call —
    // that's the same failure class as an unguarded AnyDoc crash, just on the embedding side. Fail
    // every in-flight request loudly and respawn so the NEXT call gets a fresh worker instead of
    // posting into a dead one forever.
    const onFatal = (err: Error) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker.terminate();
      this.spawn();
    };
    this.worker.onerror = (e) => onFatal(new Error(`embedding worker crashed: ${e.message}`));
    this.worker.onmessageerror = () => onFatal(new Error("embedding worker sent an unparseable message"));
  }

  embed(texts: string[]): Promise<number[][]> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, texts });
    });
  }
  readonly name = "local-transformers"; readonly model = "Xenova/all-MiniLM-L6-v2";
  readonly version = "1"; readonly dimensions = 384;
}
```

`dimensions !== 384` throws in the worker before it ever replies. Persist `embedding_model`, `embedding_dimensions`, `embedding_version` on the revision. A rejected `embed()` fails that one ingestion job normally (retried like any other job failure) instead of hanging it for the full `INGESTION_TIMEOUT_MS`. `tests/integration/embed-does-not-block-http.test.ts`: fire a large embed batch and a concurrent `GET /health`; assert the health check's latency doesn't spike with batch size. Add `tests/unit/embedder-crash-recovery.test.ts`: force the worker to throw (bad model path fixture), assert the pending `embed()` call rejects promptly and the *next* `embed()` call on the same `Embedder` instance still succeeds.

- [ ] **Step 2: Insert + search**

After chunks exist, embed `embeddingText`, insert vectors, then mark `ready` (move ready-mark from M2 to after embed). `POST /api/v1/search` with `mode: "vector"` returns hits with `chunkId`, `content`, `headingPath`, `location`, `score`.

- [ ] **Step 3: Tests**

Two chunks with distinct topics; query close to A ranks A first. Offline: unset network (or `env.allowRemoteModels = false`) and assert ingest still works.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: local MiniLM embeddings and vector search"
```

**Exit:** Spec Phase 3 acceptance. Lexical/hybrid still M4.

---

### Milestone 4: Hybrid retrieval

**Goal:** Keyword, vector, and hybrid search with RRF, metadata filters, neighbor/section expansion, and explain payload.

**Files:**
- Create: `packages/retrieval/src/lexical/libsql-fts.ts`, `hybrid.ts`, `rrf.ts`, `filters.ts`
- Modify: `drizzle/` FTS5 virtual table + triggers (spec §122.4)
- Create: `packages/core/src/services/retrieval-service.ts`
- Modify: `POST /api/v1/search`, `POST /api/v1/search/explain`, `GET /api/v1/chunks/:id?before&after`
- Create: `tests/retrieval/corpus/` + `tests/retrieval/queries.json`
- Test: `tests/unit/rrf.test.ts`, `tests/unit/filters.test.ts`, `tests/retrieval/recall.test.ts`

**RRF:**

```ts
function rrf(ranks: number[], k = 60): number {
  return ranks.reduce((sum, r) => sum + 1 / (k + r), 0);
}
```

Candidates: `VECTOR_CANDIDATES=50`, `LEXICAL_CANDIDATES=50`, then cut to `limit` (API max 50, MCP max 20). Clamp expansion: neighbors ≤ 5, section ≤ 40, document ≤ 80.

- [ ] **Step 1: FTS5**

Index `content` + joined `heading_path`. Tokenizer `unicode61`. Query `MATCH` + join filters. Unit test: invoice-like token `INV-0042` is findable (proves no Porter stemmer).

- [ ] **Step 2: Filters**

Compile `eq | neq | in | exists | gte | lte` to `json_extract` on chunk/document metadata. **Filters go inside the vector and lexical candidate queries (the `WHERE` clause each side runs before its own 50-candidate cutoff), never applied to the fused/top-K result afterward.** Filtering post-fusion can silently return zero or too-few results under any filter even when the corpus has plenty of matches — the 50-candidate pool fetched *without* the filter may not contain them at all. `tests/unit/filters.test.ts` must include a case with > 50 matching-content chunks where only a filtered subset qualifies, asserting the filtered result set isn't limited by the unfiltered candidate pool size.

- [ ] **Step 3: Hybrid + explain**

`mode: hybrid | vector | lexical`. `SearchHit.ranking` includes `finalRank`, `vectorRank`, `lexicalRank`, `fusionScore`. Explain adds timings (`embeddingMs`, `vectorSearchMs`, `lexicalSearchMs`, `fusionMs`, `totalMs`) and `matchedTerms` when lexical ran.

- [ ] **Step 4: Retrieval regression**

Fixed corpus (≥ 10 docs). `queries.json` lists `query`, `expectedChunkIds`, `k`. CI prints Recall@5, Recall@10, MRR. Fail the job if Recall@5 drops below the baseline committed with the corpus (record the baseline in `tests/retrieval/baseline.json` after the first green run).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: hybrid search with FTS5, RRF, and explain"
```

**Exit:** Spec Phase 4 acceptance. This is the last milestone before MCP.

---

### Milestone 5: MCP and URL ingest — Gate A (local live)

**Goal:** An MCP client can search the corpus. URL ingest works with SSRF protections. Local profile is a product.

**Files:**
- Create: `apps/server/src/mcp/server.ts`, `tools/*.ts`, `resources.ts`
- Create: `packages/core/src/services/url-ingest.ts` (SSRF allow/deny from spec §100)
- Modify: `apps/server/src/index.ts` mount `/mcp`
- Test: `tests/integration/mcp.test.ts`, `tests/unit/ssrf.test.ts`

**MCP tools (thin wrappers over services):**

```text
search_documents
get_document      # truncate at MAX_MCP_DOCUMENT_CHARS=32000
get_chunk
list_documents
list_collections
```

No `explain_search` MCP tool (ponytail review 2026-08-29): it would duplicate `POST /api/v1/search/explain`, which already returns the full rank/score/timing breakdown. An MCP client that wants the explanation for a hit follows its resource URI to that HTTP endpoint instead of a second server-side path to the same data.

Resources: `document://{documentId}` and `/chunks/{chunkId}` / `/normalized`.

Auth: same Bearer API keys as REST. Localhost bind may skip auth when `APP_PROFILE=local` and host is loopback **and** `AUTH_DISABLED=true` (explicit). Remote bind never skips auth.

**"Host is loopback" means the incoming request's remote socket address (`127.0.0.1`/`::1`), checked per-request — never the server's configured bind host.** This matters because M11's own local deploy example is `docker run -p 3000:3000`, which requires the process to bind `0.0.0.0` *inside* the container for Docker's port publishing to work at all. If the check reads the bind address instead of each request's actual remote address, every Docker deployment looks like "loopback" to the check, and `AUTH_DISABLED=true` (which local-mode defaults likely set) silently exposes the API to anyone who can reach the host's network interfaces — not just true localhost callers. `tests/unit/ssrf.test.ts` (or a new `tests/unit/loopback-auth.test.ts`) must assert a request arriving with a non-loopback remote address is rejected without a key even when the server is bound to `0.0.0.0`.

- [ ] **Step 1: API keys**

Create hashed keys (`key_hash` SHA-256, `key_prefix` displayed). Scopes: `read`, `write`, `admin` (collapsed from spec §97's per-resource list — ponytail review 2026-08-29: nine scopes on a single-tenant instance is unused granularity; split further only when a real multi-key deployment needs it). MCP keys default to `read`. No admin tools on MCP.

- [ ] **Step 2: Streamable HTTP MCP**

Implement `/mcp` with the official MCP TypeScript SDK if it runs on Bun; otherwise Streamable HTTP by the spec. Tools call `RetrievalService` / `DocumentService` only.

- [ ] **Step 3: URL ingest**

`POST /api/v1/documents/from-url`. Block localhost, `127.0.0.0/8`, `::1`, RFC1918, link-local, cloud metadata. Revalidate redirects (max 3). Size `MAX_UPLOAD_BYTES`, timeout `URL_FETCH_TIMEOUT_MS=30000`. Stream to blob store. Tests for blocked IPs (including redirect-to-169.254.169.254).

- [ ] **Step 4: stdio (optional)**

`bun run mcp:stdio` for local Claude/Cursor config. Same tools. Skip if Streamable HTTP already works with the target client; do not block Gate A.

- [ ] **Step 5: README + smoke**

README: `bun install`, `bun db:migrate`, `bun dev`, example MCP config pointing at `http://127.0.0.1:3000/mcp`. Manual smoke: upload one PDF, search in dashboard, search via MCP.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: MCP search tools and SSRF-safe URL ingest"
```

**Exit — Gate A:** Spec Phase 5 + URL ingest. Tag `v0.1.0-local`. A stranger can clone, run, upload, and query from Cursor/Claude without a hosted LLM.

---

### Milestone 6: Retrieval playground

**Goal:** Dashboard playground reproduces API/MCP search with ranks, scores, latency, and expansion.

**Files:**
- Create: `apps/server/src/ui/pages/playground.tsx`
- Modify: explain API as the playground backend (already M4)
- Test: Playwright or bun-based UI smoke hitting `/` playground (if too heavy, curl explain API + screenshot manual checklist in README)

- [ ] Query, collection/document filters, metadata, mode, limit, expand, explain toggle.
- [ ] Result card: document, heading path, pages, final/vector/lexical rank, fusion score, matched terms, chunk text, prev/next/expand/open.
- [ ] Commit: `feat: retrieval playground`

**Exit:** Spec Phase 6. Side-by-side comparison (spec §77) stays **out** of v1.

---

### Milestone 7: Postgres + pgvector

**Goal:** `DATABASE_DRIVER=postgres` with no application-code changes. Search behavior matches libSQL on the retrieval corpus.

**Files:**
- Create: `packages/db/src/schema/postgres/*.ts`, `packages/db/src/postgres.ts`
- Create: `packages/retrieval/src/vector/pgvector.ts`, `lexical/postgres-fts.ts`
- Modify: job claim to `FOR UPDATE SKIP LOCKED` (spec §19)
- Test: `tests/integration/postgres.test.ts` (Testcontainers or CI service)

- [ ] `vector(384)` + HNSW cosine. `search_tsv` generated `simple` tsvector + GIN.
- [ ] Same `KnowledgeRepository` / `VectorIndex` / `JobRepository` interfaces.
- [ ] Run `tests/retrieval/recall.test.ts` against Postgres; delta vs libSQL baseline documented (do not require identical ranks; require same expected IDs in top-K).
- [ ] Commit: `feat: Postgres and pgvector adapters`

**Exit:** Spec Phase 7.

---

### Milestone 8: S3

**Goal:** Stateless workers read originals from S3-compatible storage.

**Files:**
- Create: `packages/storage/src/s3.ts` (Bun S3 APIs)
- Test: `tests/integration/s3.test.ts` against MinIO in CI

- [ ] `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`.
- [ ] `POST /api/v1/documents/from-object` **disabled unless** `ENABLE_FROM_OBJECT=true`. Copies into canonical `documents/{id}/revisions/{rev}/original` (do not reference foreign keys as source of truth).
- [ ] Commit: `feat: S3-compatible blob store`

**Exit:** Spec Phase 8.

---

### Milestone 9: Observability

**Goal:** Operators can tell if the instance is healthy without an external APM.

**Files:**
- Create: `apps/server/src/http/health.ts`, `metrics.ts`, `log.ts`
- Modify: UI System + Jobs pages
- Test: `tests/integration/health.test.ts`

- [ ] `GET /health` liveness. `GET /ready` checks DB, storage, embedding file present, migrations, worker loop alive, **the embedding `Worker` thread responds to a no-op ping within a short timeout (catches a crashed-and-mid-respawn worker that M3's recovery didn't finish), and a subprocess can actually be spawned (catches a `PATH`/permissions problem in a locked-down container that would otherwise fail every ingestion job while `/ready` reports green)**.
- [ ] `GET /api/v1/system/status` per spec §81.
- [ ] `GET /metrics`: `documents_total`, `documents_failed_total`, `job_queue_depth`, `search_duration_seconds`. Ponytail review 2026-08-29: ship these four, not all ~20 names in spec §82 — add a series when an operator asks a question it would answer, not before.
- [ ] JSON logs with `requestId`, `documentId`, `jobId`, `operation`, `durationMs`. Never log content, embeddings, secrets, or `Authorization`.
- [ ] Commit: `feat: health, readiness, metrics, and structured logs`

**Exit:** Spec Phase 9.

---

### Milestone 10: Webhooks (post-v1, not on the go-live path)

Cut from Gate B per ponytail review 2026-08-29 — spec §86–91 in full (HMAC signing, 5-step backoff, delivery history UI) is real effort against zero known consumers. Pick this milestone back up once something actually needs push notification of `document.ready`/`job.failed`; until then the jobs dashboard and `GET /api/v1/documents/:id` cover it by polling. If picked up, the original spec (§86–91) and interfaces below still apply unchanged:

```ts
// HMAC-SHA256 over `${timestamp}.${rawBody}`
// headers: X-Webhook-ID, X-Webhook-Timestamp, X-Webhook-Signature
```

CRUD + `GET /deliveries` + `POST /test`. Timeout 10 s. Retry 1m / 5m / 30m / 2h / 12h.

---

### Milestone 11: Production cut — Gate B (v1 live)

**Goal:** A stranger can run local **or** server profile in Docker and trust it as v1.

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml` (optional Postgres + MinIO for server demo)
- Create: `docs/deploy.md`, `docs/backup.md`
- Modify: `README.md` (local vs server)
- Create: CI workflow: `bun test`, retrieval recall, docker build
- Test: compose smoke script

- [ ] **Image** contains Bun app, UI bundle, migrations, `models/default`, AnyDoc native (or WASM) for `linux/amd64` (and arm64 if you claim it). **Verify the M2 subprocess-entry script and M3 worker-thread script exist as independently invocable files in the built image, not just in dev.** M0–M3 run straight off source files on disk (`Bun.spawn(["bun", "run", subprocessEntryPath])`, `new Worker(new URL("./worker-thread.ts", import.meta.url))`) where this "just works"; if the build step bundles the server into one artifact (which the spec favors), these two entry points can get inlined away and every parse/embed fails only in the container, never locally. Add to the compose smoke script: upload a real document through the running image and confirm it reaches `ready`, not just that the container boots.
- [ ] **Local:** `docker run -p 3000:3000 -v knowledge:/app/data`.
- [ ] **Server compose:** API+workers, Postgres+pgvector, MinIO, `APP_PROFILE=server`. Two API replicas, one worker replica — ingest still works (proves S3+SKIP LOCKED).
- [ ] **Backups:** document “copy `data/` + sqlite” (local) and “Postgres dump + S3 versioning” (server). Indexes reconstructable from originals.
- [ ] **Reindex-stale:** `POST /api/v1/documents/:id/reindex` logs when parser/chunker/embedding versions differ from the document's current revision (spec §104). Downscoped from a proactive dashboard banner (ponytail review 2026-08-29) — no second version has shipped yet to prove the banner is worth building; add it once a real version bump makes the manual check annoying.
- [ ] **Auth default:** server profile requires API key; refuse `0.0.0.0` + `AUTH_DISABLED`.
- [ ] **Tag** `v1.0.0`. Changelog from M1–M11 (M10/webhooks not included — see Go-live gates).

```bash
git commit -m "chore: Docker, compose, and v1 release notes"
git tag v1.0.0
```

**Exit — Gate B:** Spec §126 v1 release criteria. Product is live.

---

## Testing strategy (applies to every milestone)

| Layer | Command | What |
| --- | --- | --- |
| Unit | `bun test tests/unit` | IDs, RRF, filters, signing, chunker, SSRF, parser map |
| Integration | `bun test tests/integration` | libSQL always; Postgres/S3 in M7/M8 CI |
| Retrieval | `bun test tests/retrieval` | Recall@5/10, MRR vs `baseline.json` |
| Smoke | `bun dev` + curl/MCP | Gate A and Gate B checklists below |

Do not land a milestone if its **Exit** box is unchecked.

---

## Gate A checklist (local live)

- [ ] `bun install && bun db:migrate && bun dev` on a clean machine
- [ ] Upload MD, DOCX, and PDF → `ready`
- [ ] Scanned-PDF fixture → `DOCUMENT_NEEDS_OCR` in UI
- [ ] Duplicate file → same `doc_` id
- [ ] Hybrid search returns provenance (heading path + location)
- [ ] Explain shows vector and lexical ranks
- [ ] MCP `search_documents` from Cursor/Claude against `/mcp`
- [ ] No outbound AI HTTP during ingest (MiniLM local)
- [ ] Tag `v0.1.0-local`

---

## Gate B checklist (production live)

- [ ] All Gate A checks against `APP_PROFILE=server`
- [ ] Postgres recall corpus matches expected IDs in top-10
- [ ] Two API processes + worker share S3 originals
- [ ] `/ready` fails if DB or model missing
- [ ] `/metrics` scrapes
- [ ] URL ingest rejects RFC1918 and metadata IPs — hardcoded deny-list, no config override (ponytail review 2026-08-29: no exception knob on this boundary)
- [ ] Docker image runs without network for embeddings
- [ ] Tag `v1.0.0`

---

## Risks (handle in the named milestone, do not ignore)

| Risk | Milestone | Mitigation |
| --- | --- | --- |
| AnyDoc N-API broken on Bun | M0 | WASM adapter; freeze winner in spike note |
| Transformers.js broken on Bun | M0 / M3 | `onnxruntime-node` + same ONNX; keep `Embedder` interface |
| AnyDoc crash takes down the API | M2 | Parse always runs in a spawned subprocess (Step 2); crash → `DOCUMENT_MALFORMED` job failure, server unaffected |
| Subprocess stdin/stdout/stderr pipe deadlock on large documents | M2 | Drain stdout/stderr concurrently with writing stdin (Step 2); test a near-`MAX_DOCUMENT_PAGES` fixture, not just a small one |
| Embedding batch stalls the event loop | M3 | Inference always runs in a `Worker` thread (Step 1); HTTP/MCP never call the pipeline directly |
| Embedding worker crash hangs all future ingestion silently | M3 | `onerror`/`onmessageerror` reject in-flight calls and respawn the worker (Step 1); crash-recovery test required |
| `Bun.spawn`/`Worker` behave differently than Node's under load | M0 / M2 / M3 | Spike both patterns (not just the bare library calls) before M2/M3 depend on them |
| libSQL vector quality vs pgvector | M7 | Recall tests on both; do not fake identical scores |
| FTS5 vs `tsvector` ranking drift | M4 / M7 | RRF on ranks, not raw scores |
| MiniLM English-only | product | Document in README; do not silently add a second model in v1 |
| Native AnyDoc in Docker | M11 | Multi-arch binaries or WASM in the image |
| Metadata filters silently drop matches | M4 | Filters run inside vector/lexical candidate queries, before the 50-cutoff, not after fusion |
| "Loopback" auth-skip misfires under Docker's required `0.0.0.0` bind | M5 | Check the per-request remote socket address, never the configured bind host |
| Bundled build inlines away the subprocess/worker entry files | M11 | Confirm both exist as invocable paths in the built image; smoke-test an actual upload against the container |

---

## Out of scope for go-live

From spec §111, §127, §128: TypeScript SDK, chat, agents, hosted LLM, SSO, RBAC, reranker, OCR, comparison playground, workspace multi-tenancy, Drive/GitHub sync.

Added by ponytail review 2026-08-29 (speculative before v1 has a real consumer/second version to justify them): webhooks (§86–91, was M10), `explain_search` MCP tool, proactive reindex-stale dashboard banner, per-resource API-key scopes beyond `read`/`write`/`admin`, and any `/metrics` series beyond the four shipped in M9.

---

## Spec coverage

| Spec area | Milestone |
| --- | --- |
| §6 repo, §5 Bun.serve + React/shadcn | M0–M1 |
| §8–11 domain, §46–57 documents HTTP, §98 limits | M1 |
| §14–25 parse/chunk/jobs | M2 |
| §26–33 embeddings + vector | M3 |
| §34–42, §58–60, §92–93, §117–120 retrieval | M4 |
| §48 URL ingest, §62–71 MCP, §96–97 keys | M5 |
| §72–76 playground | M6 |
| §7 Postgres/pgvector, §19 SKIP LOCKED | M7 |
| §43–44, §49 S3 | M8 |
| §78–85 observability (trimmed metrics, see M9) | M9 |
| §86–91 webhooks | M10 — post-v1, not on the go-live path |
| §112–115 Docker, backups, §126 v1 | M11 |

---

## Execution notes

Work **one milestone at a time**. Each milestone’s last commit should leave `bun test` green and `bun dev` runnable. Do not start M7 before M4 (retrieval interfaces must exist). M6 and M9 may proceed in parallel after Gate A if multiple people are implementing.
