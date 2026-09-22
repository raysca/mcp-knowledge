import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

describe("MCP", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-mcp-"));
    const env = loadEnv({
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    const app = await createApp(env);
    stop = app.stop;
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
    const documentIds: string[] = [];
    for (const [filename, content] of [
      ["first.md", "# First\n\nSearchable paragraph about widgets."],
      ["second.md", "# Second\n\nSearchable paragraph about gadgets."],
      ["third.md", "# Third\n\nSearchable paragraph about tools."],
    ]) {
      const form = new FormData();
      form.set("file", new File([content], filename));
      const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
      const body = (await created.json()) as { id: string };
      documentIds.push(body.id);
    }
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const states = await Promise.all(
        documentIds.map(async (id) =>
          (await (await fetch(`${base}/api/v1/documents/${id}`)).json()) as { status: string },
        ),
      );
      if (states.every((doc) => doc.status === "ready")) break;
      await Bun.sleep(50);
    }
  }, 60_000);

  afterAll(async () => {
    stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  async function rpc(method: string, params?: unknown) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: res.status, body: await res.json() };
  }

  test("initialize and tools/list", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.status).toBe(200);
    expect((init.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe(
      "mcp-knowledge",
    );
    const listed = await rpc("tools/list");
    const names = (
      listed.body as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((t) => t.name);
    expect(names).toContain("search_documents");
    expect(names).not.toContain("explain_search");
  });

  test("search_documents returns hits", async () => {
    const res = await rpc("tools/call", {
      name: "search_documents",
      arguments: { query: "widgets", limit: 5 },
    });
    const text = (res.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    const hits = JSON.parse(text) as Array<{ documentId: string; resourceUri: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.resourceUri.startsWith("document://")).toBe(true);
  });

  test("list_documents follows its opaque cursor to the next page", async () => {
    const first = await rpc("tools/call", {
      name: "list_documents",
      arguments: { limit: 1 },
    });
    const firstPage = JSON.parse(
      (first.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as { items: Array<{ id: string }>; nextCursor?: string };

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeString();

    const second = await rpc("tools/call", {
      name: "list_documents",
      arguments: { limit: 1, cursor: firstPage.nextCursor },
    });
    const secondPage = JSON.parse(
      (second.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as { items: Array<{ id: string }> };

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
  });
});
