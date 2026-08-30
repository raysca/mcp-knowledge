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

describe("purge corpus", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-purge-"));
    const env = loadEnv({
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    const app = await createApp(env);
    stop = app.stop;
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("purge clears search and blobs; collection remains; same file is not a duplicate", async () => {
    const col = await fetch(`${base}/api/v1/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Keep" }),
    });
    expect(col.status).toBe(201);
    const collectionId = ((await col.json()) as { id: string }).id;

    const form = new FormData();
    form.set("file", new File(["# Invoices\n\nPayment for invoice INV-0042.\n"], "inv.md"));
    const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    const { id } = (await created.json()) as { id: string };
    await waitReady(base, id);

    const hit = await fetch(`${base}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "INV-0042", mode: "lexical", limit: 5 }),
    });
    expect(((await hit.json()) as { hits: unknown[] }).hits.length).toBeGreaterThan(0);

    const refused = await fetch(`${base}/api/v1/documents/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "nope" }),
    });
    expect(refused.status).toBe(400);

    const purged = await fetch(`${base}/api/v1/documents/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "purge" }),
    });
    expect(purged.status).toBe(200);
    const counts = (await purged.json()) as { deletedDocuments: number; deletedBlobs: number };
    expect(counts.deletedDocuments).toBe(1);
    expect(counts.deletedBlobs).toBeGreaterThan(0);

    const listed = await (await fetch(`${base}/api/v1/documents`)).json() as { items: unknown[] };
    expect(listed.items).toEqual([]);
    const empty = await fetch(`${base}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "INV-0042", mode: "lexical", limit: 5 }),
    });
    expect(((await empty.json()) as { hits: unknown[] }).hits).toEqual([]);
    const cols = await (await fetch(`${base}/api/v1/collections`)).json() as { items: Array<{ id: string }> };
    expect(cols.items.some((c) => c.id === collectionId)).toBe(true);

    const again = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    expect(again.status).toBe(202);
    const second = (await again.json()) as { id: string; duplicate?: boolean };
    expect(second.duplicate).toBeFalsy();
    expect(second.id).not.toBe(id);
  }, 60_000);
});
