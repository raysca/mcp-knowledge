import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

const PG_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mcp_knowledge";

async function isPostgresReachable(): Promise<boolean> {
  const sql = postgres(PG_URL, { connect_timeout: 1, max: 1 });
  try {
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    await sql.end({ timeout: 0 }).catch(() => {});
    return false;
  }
}

const hasPostgres = await isPostgresReachable();

async function waitReady(base: string, id: string, ms = 60_000) {
  const start = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - start < ms) {
    const res = await fetch(`${base}/api/v1/documents/${id}`);
    const doc = (await res.json()) as { status?: string; latestError?: string };
    if (doc.status === "ready") return doc;
    lastStatus = `${doc.status}: ${doc.latestError ?? ""}`;
    if (doc.status === "failed") throw new Error(`document ${id} failed: ${lastStatus}`);
    await Bun.sleep(50);
  }
  throw new Error(`document ${id} timed out: ${lastStatus}`);
}

describe.skipIf(!hasPostgres)("PostgreSQL 18 & SQLite Hybrid Search Parity (End-to-End)", () => {
  let pgDir = "";
  let sqliteDir = "";
  let pgServer: Bun.Server<undefined>;
  let sqliteServer: Bun.Server<undefined>;
  let pgBase = "";
  let sqliteBase = "";
  let stopPg: () => void;
  let stopSqlite: () => void;
  let pgClient: postgres.Sql;

  let pgInvoiceId = "";
  let sqliteInvoiceId = "";

  beforeAll(async () => {
    // Clean Postgres tables before starting
    pgClient = postgres(PG_URL);
    await pgClient`TRUNCATE TABLE collections, documents, document_revisions, document_chunks, ingestion_jobs, archive_imports, api_keys, source_scan_state, source_files, corpus_state CASCADE`;
    await pgClient`INSERT INTO corpus_state (id, generation) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET generation = 0`;

    pgDir = await mkdtemp(join(tmpdir(), "mcp-pg-e2e-"));
    sqliteDir = await mkdtemp(join(tmpdir(), "mcp-sqlite-e2e-"));

    const pgEnv = loadEnv({
      DATABASE_DRIVER: "postgres",
      DATABASE_URL: PG_URL,
      STORAGE_PATH: join(pgDir, "blobs"),
    });
    const pgApp = await createApp(pgEnv);
    stopPg = pgApp.stop;
    pgServer = Bun.serve({ fetch: pgApp.fetch, hostname: "127.0.0.1", port: 0 });
    pgBase = `http://127.0.0.1:${pgServer.port}`;

    const sqliteEnv = loadEnv({
      DATABASE_DRIVER: "libsql",
      DATABASE_URL: `file:${join(sqliteDir, "app.db")}`,
      STORAGE_PATH: join(sqliteDir, "blobs"),
    });
    const sqliteApp = await createApp(sqliteEnv);
    stopSqlite = sqliteApp.stop;
    sqliteServer = Bun.serve({ fetch: sqliteApp.fetch, hostname: "127.0.0.1", port: 0 });
    sqliteBase = `http://127.0.0.1:${sqliteServer.port}`;

    // Upload invoice document to both
    const invContent = "# Invoices\n\nPayment for invoice INV-0042 is due in thirty days.\n";
    for (const [base, isPg] of [[pgBase, true], [sqliteBase, false]] as const) {
      const form = new FormData();
      form.set("file", new File([invContent], "inv.md"));
      const res = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
      const json = (await res.json()) as { id: string };
      if (isPg) pgInvoiceId = json.id;
      else sqliteInvoiceId = json.id;
      await waitReady(base, json.id);
    }

    // Upload garden documents to both
    const gardenDocs = [
      ["dominant.md", Array.from({ length: 3 }, (_, i) => `# Part ${i}\n\n${"marigold planting ".repeat(45)} section ${i}`).join("\n\n")],
      ["other-one.md", `# Garden One\n\n${"marigold planting ".repeat(45)}`],
      ["other-two.md", `# Garden Two\n\n${"marigold planting ".repeat(45)}`],
    ];

    for (const base of [pgBase, sqliteBase]) {
      for (const [filename, content] of gardenDocs) {
        const form = new FormData();
        form.set("file", new File([content], filename));
        const res = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
        const json = (await res.json()) as { id: string };
        await waitReady(base, json.id);
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (stopPg) stopPg();
    if (pgServer) pgServer.stop(true);
    if (stopSqlite) stopSqlite();
    if (sqliteServer) sqliteServer.stop(true);
    if (pgClient) await pgClient.end();
    await rm(pgDir, { recursive: true, force: true }).catch(() => {});
    await rm(sqliteDir, { recursive: true, force: true }).catch(() => {});
  });

  test("lexical mode parity: finds exact SKU/invoice INV-0042 at rank 1", async () => {
    const pgRes = await fetch(`${pgBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "INV-0042", mode: "lexical", limit: 8 }),
    });
    expect(pgRes.status).toBe(200);
    const pgBody = (await pgRes.json()) as { hits: Array<{ documentId: string; ranking: { lexicalRank?: number } }> };
    expect(pgBody.hits.length).toBeGreaterThanOrEqual(1);
    expect(pgBody.hits[0]?.documentId).toBe(pgInvoiceId);
    expect(pgBody.hits[0]?.ranking.lexicalRank).toBe(1);

    const sqliteRes = await fetch(`${sqliteBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "INV-0042", mode: "lexical", limit: 8 }),
    });
    expect(sqliteRes.status).toBe(200);
    const sqliteBody = (await sqliteRes.json()) as { hits: Array<{ documentId: string; ranking: { lexicalRank?: number } }> };
    expect(sqliteBody.hits[0]?.documentId).toBe(sqliteInvoiceId);
    expect(sqliteBody.hits[0]?.ranking.lexicalRank).toBe(1);
  });

  test("lexical mode parity: prefix wildcard search INV-004*", async () => {
    const pgRes = await fetch(`${pgBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "INV-004*", mode: "lexical", limit: 8 }),
    });
    expect(pgRes.status).toBe(200);
    const pgBody = (await pgRes.json()) as { hits: Array<{ documentId: string }> };
    expect(pgBody.hits.some((h) => h.documentId === pgInvoiceId)).toBe(true);

    const sqliteRes = await fetch(`${sqliteBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "INV-004*", mode: "lexical", limit: 8 }),
    });
    expect(sqliteRes.status).toBe(200);
    const sqliteBody = (await sqliteRes.json()) as { hits: Array<{ documentId: string }> };
    expect(sqliteBody.hits.some((h) => h.documentId === sqliteInvoiceId)).toBe(true);
  });

  test("vector search parity: returns hits with vector score and rank", async () => {
    const query = "payment due in thirty days";
    const pgRes = await fetch(`${pgBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode: "vector", limit: 5 }),
    });
    expect(pgRes.status).toBe(200);
    const pgBody = (await pgRes.json()) as { hits: Array<{ documentId: string; ranking: { vectorRank?: number; vectorScore?: number } }> };
    expect(pgBody.hits.length).toBeGreaterThanOrEqual(1);
    expect(pgBody.hits[0]?.documentId).toBe(pgInvoiceId);
    expect(pgBody.hits[0]?.ranking.vectorRank).toBe(1);
    expect(pgBody.hits[0]?.ranking.vectorScore).toBeGreaterThan(0.5);

    const sqliteRes = await fetch(`${sqliteBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode: "vector", limit: 5 }),
    });
    expect(sqliteRes.status).toBe(200);
    const sqliteBody = (await sqliteRes.json()) as { hits: Array<{ documentId: string; ranking: { vectorRank?: number; vectorScore?: number } }> };
    expect(sqliteBody.hits[0]?.documentId).toBe(sqliteInvoiceId);
    expect(sqliteBody.hits[0]?.ranking.vectorRank).toBe(1);
  });

  test("hybrid search parity: Reciprocal Rank Fusion combines vector and lexical", async () => {
    const query = "thirty days invoice payment";
    const pgRes = await fetch(`${pgBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode: "hybrid", limit: 5 }),
    });
    expect(pgRes.status).toBe(200);
    const pgBody = (await pgRes.json()) as {
      hits: Array<{
        documentId: string;
        ranking: {
          finalRank: number;
          fusionScore?: number;
          vectorRank?: number;
          lexicalRank?: number;
        };
      }>;
    };
    expect(pgBody.hits[0]?.documentId).toBe(pgInvoiceId);
    expect(pgBody.hits[0]?.ranking.finalRank).toBe(1);
    expect(pgBody.hits[0]?.ranking.fusionScore).toBeGreaterThan(0);
    expect(pgBody.hits[0]?.ranking.vectorRank).toBeDefined();
    expect(pgBody.hits[0]?.ranking.lexicalRank).toBeDefined();

    const sqliteRes = await fetch(`${sqliteBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode: "hybrid", limit: 5 }),
    });
    expect(sqliteRes.status).toBe(200);
    const sqliteBody = (await sqliteRes.json()) as {
      hits: Array<{
        documentId: string;
        ranking: {
          finalRank: number;
          fusionScore?: number;
        };
      }>;
    };
    expect(sqliteBody.hits[0]?.documentId).toBe(sqliteInvoiceId);
    expect(sqliteBody.hits[0]?.ranking.finalRank).toBe(1);
    expect(sqliteBody.hits[0]?.ranking.fusionScore).toBeGreaterThan(0);
  });

  test("document collapsed search parity: collapse: 'document' returns distinct documents", async () => {
    const query = "marigold planting";
    const pgRes = await fetch(`${pgBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode: "hybrid", collapse: "document", limit: 5 }),
    });
    expect(pgRes.status).toBe(200);
    const pgBody = (await pgRes.json()) as {
      hits: Array<{
        documentId: string;
        matchingChunkCount: number;
        matchedHeadings: string[];
      }>;
    };
    const pgDocIds = pgBody.hits.map((h) => h.documentId);
    const uniquePgDocIds = new Set(pgDocIds);
    expect(uniquePgDocIds.size).toBe(pgDocIds.length); // Every hit is a distinct document
    expect(pgBody.hits[0]?.matchingChunkCount).toBeGreaterThanOrEqual(1);

    const sqliteRes = await fetch(`${sqliteBase}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, mode: "hybrid", collapse: "document", limit: 5 }),
    });
    expect(sqliteRes.status).toBe(200);
    const sqliteBody = (await sqliteRes.json()) as {
      hits: Array<{
        documentId: string;
        matchingChunkCount: number;
      }>;
    };
    const sqliteDocIds = sqliteBody.hits.map((h) => h.documentId);
    const uniqueSqliteDocIds = new Set(sqliteDocIds);
    expect(uniqueSqliteDocIds.size).toBe(sqliteDocIds.length);
  });

  test("document catalog parity: exposes corpusVersion and items", async () => {
    const pgRes = await fetch(`${pgBase}/api/v1/document-catalog`);
    expect(pgRes.status).toBe(200);
    const pgCatalog = (await pgRes.json()) as {
      corpusVersion: string;
      items: Array<{ id: string; status: string; title?: string }>;
    };
    expect(pgCatalog.corpusVersion).toMatch(/^generation:\d+$/);
    expect(pgCatalog.items.length).toBe(4);
    expect(pgCatalog.items.some((i) => i.id === pgInvoiceId)).toBe(true);

    const sqliteRes = await fetch(`${sqliteBase}/api/v1/document-catalog`);
    expect(sqliteRes.status).toBe(200);
    const sqliteCatalog = (await sqliteRes.json()) as {
      corpusVersion: string;
      items: Array<{ id: string; status: string }>;
    };
    expect(sqliteCatalog.corpusVersion).toMatch(/^generation:\d+$/);
    expect(sqliteCatalog.items.length).toBe(4);
    expect(sqliteCatalog.items.some((i) => i.id === sqliteInvoiceId)).toBe(true);
  });

  test("search explain parity: contains matchedTerms and timings", async () => {
    const pgRes = await fetch(`${pgBase}/api/v1/search/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "invoice INV-004*", mode: "hybrid", limit: 5 }),
    });
    expect(pgRes.status).toBe(200);
    const pgExplain = (await pgRes.json()) as {
      matchedTerms: string[];
      timings: Record<string, number>;
      hits: unknown[];
      vector: unknown[];
      lexical: unknown[];
    };
    expect(pgExplain.matchedTerms).toContain("inv-004*");
    expect(pgExplain.timings.totalMs).toBeGreaterThan(0);
    expect(pgExplain.hits.length).toBeGreaterThanOrEqual(1);
  });
});
