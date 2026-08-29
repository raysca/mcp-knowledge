import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

async function waitForStatus(base: string, id: string, want: string[], ms = 60_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const res = await fetch(`${base}/api/v1/documents/${id}`);
    const doc = (await res.json()) as { status?: string; latestError?: string | null };
    if (doc.status && want.includes(doc.status)) return doc;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${want.join("|")}`);
}

async function upload(base: string, filename: string, body: string) {
  const form = new FormData();
  form.set("file", new File([body], filename));
  const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
  const json = (await created.json()) as { id: string };
  await waitForStatus(base, json.id, ["ready"]);
  return json.id;
}

describe("vector search", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-knowledge-search-"));
    const env = loadEnv({
      AUTH_DISABLED: "true",
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    const app = await createApp(env);
    stop = app.stop;
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("query close to document A ranks A first", async () => {
    const plants = await upload(
      base,
      "plants.md",
      "# Plants\n\nPhotosynthesis converts sunlight into energy in chloroplasts using chlorophyll in green leaves.",
    );
    await upload(
      base,
      "quantum.md",
      "# Computers\n\nQuantum computing uses qubits and superposition to factor large integers with Shor's algorithm.",
    );

    const res = await fetch(`${base}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "chlorophyll photosynthesis in plant leaves",
        mode: "vector",
        limit: 8,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{
        chunkId: string;
        documentId: string;
        content: string;
        score: number;
        ranking: { finalRank: number; vectorRank?: number; vectorScore?: number };
      }>;
    };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0]!.documentId).toBe(plants);
    expect(body.hits[0]!.ranking.vectorRank).toBe(1);
    expect(body.hits[0]!.chunkId.startsWith("chk_")).toBe(true);
  }, 120_000);
});
