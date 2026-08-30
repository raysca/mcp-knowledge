import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

async function waitReady(base: string, id: string, ms = 60_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const res = await fetch(`${base}/api/v1/documents/${id}`);
    const doc = (await res.json()) as { status?: string };
    if (doc.status === "ready") return doc;
    await Bun.sleep(50);
  }
  throw new Error("timeout");
}

describe("hybrid search", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;
  let invoiceId = "";
  let chunkId = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-hybrid-"));
    const env = loadEnv({
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    const app = await createApp(env);
    stop = app.stop;
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
    const form = new FormData();
    form.set(
      "file",
      new File(["# Invoices\n\nPayment for invoice INV-0042 is due in thirty days.\n"], "inv.md"),
    );
    const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    const json = (await created.json()) as { id: string };
    invoiceId = json.id;
    await waitReady(base, invoiceId);
    const chunks = await fetch(`${base}/api/v1/documents/${invoiceId}/chunks`);
    const listed = (await chunks.json()) as { items: Array<{ id: string }> };
    chunkId = listed.items[0]!.id;
  }, 60_000);

  afterAll(async () => {
    stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("lexical mode finds INV-0042", async () => {
    const res = await fetch(`${base}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "INV-0042", mode: "lexical", limit: 8 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ documentId: string; ranking: { lexicalRank?: number } }> };
    expect(body.hits[0]?.documentId).toBe(invoiceId);
    expect(body.hits[0]?.ranking.lexicalRank).toBe(1);
  });

  test("explain includes timings and fusion fields", async () => {
    const res = await fetch(`${base}/api/v1/search/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "invoice payment", mode: "hybrid", limit: 8 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ ranking: { fusionScore?: number } }>;
      timings: { totalMs: number; lexicalSearchMs: number };
      matchedTerms: string[];
    };
    expect(body.hits[0]?.ranking.fusionScore).toBeGreaterThan(0);
    expect(body.timings.totalMs).toBeGreaterThan(0);
    expect(body.matchedTerms.length).toBeGreaterThan(0);
  });

  test("GET /chunks/:id returns neighbors", async () => {
    const res = await fetch(`${base}/api/v1/chunks/${chunkId}?before=1&after=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.some((c) => c.id === chunkId)).toBe(true);
  });
});
