import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import queries from "./queries.json";
import baseline from "./baseline.json";

async function waitReady(base: string, id: string, ms = 60_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const res = await fetch(`${base}/api/v1/documents/${id}`);
    const doc = (await res.json()) as { status?: string };
    if (doc.status === "ready") return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${id}`);
}

describe("retrieval recall", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;
  const fileToDoc = new Map<string, string>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-recall-"));
    const env = loadEnv({
      AUTH_DISABLED: "true",
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    const app = await createApp(env);
    stop = app.stop;
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
    const corpus = join(import.meta.dir, "corpus");
    for (const name of (await readdir(corpus)).sort()) {
      if (!name.endsWith(".md")) continue;
      const body = await Bun.file(join(corpus, name)).text();
      const form = new FormData();
      form.set("file", new File([body], name));
      const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
      const json = (await created.json()) as { id: string };
      await waitReady(base, json.id);
      fileToDoc.set(name, json.id);
    }
  }, 180_000);

  afterAll(async () => {
    stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("Recall@5 stays at the committed baseline", async () => {
    let hits5 = 0;
    let hits10 = 0;
    let mrr = 0;
    for (const q of queries) {
      const expectedId = fileToDoc.get(q.file);
      const res = await fetch(`${base}/api/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q.query, mode: "hybrid", limit: 10 }),
      });
      const body = (await res.json()) as { hits: Array<{ documentId: string }> };
      const rank = body.hits.findIndex((h) => h.documentId === expectedId) + 1;
      if (rank > 0) {
        mrr += 1 / rank;
        if (rank <= 5) hits5++;
        if (rank <= 10) hits10++;
      }
      console.log(`recall ${q.file} rank=${rank || "miss"} query=${q.query}`);
    }
    const n = queries.length;
    const recallAt5 = hits5 / n;
    const recallAt10 = hits10 / n;
    const mrrScore = mrr / n;
    console.log(`Recall@5=${recallAt5} Recall@10=${recallAt10} MRR=${mrrScore}`);
    expect(recallAt5).toBeGreaterThanOrEqual(baseline.recallAt5);
    expect(recallAt10).toBeGreaterThanOrEqual(baseline.recallAt10);
    expect(mrrScore).toBeGreaterThanOrEqual(baseline.mrr);
  }, 120_000);
});
