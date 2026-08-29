import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

describe("embed does not block HTTP", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-knowledge-embed-http-"));
    const env = loadEnv({
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

  test("GET /health stays fast while a large embed batch runs", async () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, i) =>
        `Paragraph ${i} discusses retrieval, embeddings, and document knowledge infrastructure in isolation from chat UIs.`,
    ).join("\n\n");
    const form = new FormData();
    form.set("file", new File([`# Batch\n\n${paragraphs}`], "batch.md"));
    void fetch(`${base}/api/v1/documents`, { method: "POST", body: form });

    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const res = await fetch(`${base}/health`);
      samples.push(performance.now() - t0);
      expect(res.status).toBe(200);
      await Bun.sleep(40);
    }
    expect(Math.max(...samples)).toBeLessThan(500);
  }, 60_000);
});
