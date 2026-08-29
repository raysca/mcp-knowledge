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

describe("ingestion", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-knowledge-ing-"));
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

  test("markdown upload becomes ready with chunks", async () => {
    const form = new FormData();
    form.set("file", new File(["# Title\n\nA paragraph about retrieval."], "guide.md"));
    const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    expect(created.status).toBe(202);
    const body = (await created.json()) as { id: string };
    const doc = await waitForStatus(base, body.id, ["ready"]);
    expect(doc.status).toBe("ready");

    const chunks = await fetch(`${base}/api/v1/documents/${body.id}/chunks`);
    expect(chunks.status).toBe(200);
    const listed = (await chunks.json()) as { items: Array<{ content: string; headingPath: string[] }> };
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items[0]!.headingPath).toContain("Title");

    const normalized = await fetch(`${base}/api/v1/documents/${body.id}/normalized`);
    expect(normalized.status).toBe(200);
    const n = (await normalized.json()) as { blocks: unknown[] };
    expect(n.blocks.length).toBeGreaterThan(0);
  });

  test("docx fixture is parsed via anydoc subprocess", async () => {
    const bytes = await Bun.file(new URL("../../scripts/fixtures/hello.docx", import.meta.url)).bytes();
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], "hello.docx"));
    const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    expect(created.status).toBe(202);
    const body = (await created.json()) as { id: string };
    await waitForStatus(base, body.id, ["ready"]);
    const chunks = await fetch(`${base}/api/v1/documents/${body.id}/chunks`);
    const listed = (await chunks.json()) as { items: unknown[] };
    expect(listed.items.length).toBeGreaterThan(0);
  });
});
