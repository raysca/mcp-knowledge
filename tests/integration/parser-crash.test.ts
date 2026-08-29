import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseInSubprocess } from "../../packages/parser/src/anydoc/subprocess-runner.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

describe("parser subprocess isolation", () => {
  test("crash in the child does not take down /health", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-knowledge-crash-"));
    const env = loadEnv({
      AUTH_DISABLED: "true",
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    const app = await createApp(env);
    const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const crash = fileURLToPath(new URL("../fixtures/crash-entry.ts", import.meta.url));
    await expect(parseInSubprocess(new Uint8Array([1, 2, 3]), 5_000, crash)).rejects.toThrow(/exit 1/);
    const health = await fetch(`${base}/health`);
    const docs = await fetch(`${base}/api/v1/documents`);
    expect(health.status).toBe(200);
    expect(docs.status).toBe(200);
    app.stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("hello.docx subprocess completes well under PARSER_TIMEOUT_MS", async () => {
    const bytes = await Bun.file(new URL("../../scripts/fixtures/hello.docx", import.meta.url)).bytes();
    const start = Date.now();
    const doc = await parseInSubprocess(bytes, 30_000);
    expect(doc.blocks.length).toBeGreaterThan(0);
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});
