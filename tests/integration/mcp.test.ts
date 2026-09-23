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
  let contextChunks: Array<{ id: string; content: string }> = [];

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
      [
        "first.md",
        `# Opening\n\n${"opening ".repeat(85)}\n\n# Widgets\n\n${"widgets ".repeat(85)}\n\n# Closing\n\n${"closing ".repeat(85)}`,
      ],
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
    const chunks = await fetch(`${base}/api/v1/documents/${documentIds[0]}/chunks`);
    contextChunks = ((await chunks.json()) as { items: typeof contextChunks }).items;
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
    const tools = (listed.body as {
      result: {
        tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
      };
    }).result.tools;
    const search = tools.find((tool) => tool.name === "search_documents")!;
    const chunk = tools.find((tool) => tool.name === "get_chunk")!;
    expect(search.inputSchema.properties.filters).toMatchObject({ type: "object" });
    expect(search.inputSchema.properties.expand).toMatchObject({
      type: "object",
      properties: {
        type: { enum: ["none", "neighbors", "section"] },
        before: { type: "integer", minimum: 0, maximum: 5 },
        after: { type: "integer", minimum: 0, maximum: 5 },
      },
    });
    expect(chunk.inputSchema.properties.before).toMatchObject({
      type: "integer", minimum: 0, maximum: 5,
    });
    expect(chunk.inputSchema.properties.after).toMatchObject({
      type: "integer", minimum: 0, maximum: 5,
    });
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

  test("search_documents expands neighboring chunks", async () => {
    const expanded = await rpc("tools/call", {
      name: "search_documents",
      arguments: {
        query: "widgets",
        mode: "lexical",
        expand: { type: "neighbors", before: 1, after: 1 },
      },
    });
    const hits = JSON.parse(
      (expanded.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as Array<{ content: string }>;
    expect(hits[0]!.content).toContain("opening");
    expect(hits[0]!.content).toContain("widgets");
    expect(hits[0]!.content).toContain("closing");
  });

  test("search_documents passes malformed filters to service validation", async () => {
    const malformed = await rpc("tools/call", {
      name: "search_documents",
      arguments: { query: "widgets", filters: "invalid" },
    });
    expect((malformed.body as { result: { isError?: boolean } }).result.isError).toBe(true);
    expect(
      (malformed.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ).toContain("filters must be an object");
  });

  test("get_chunk returns requested neighbors in sequence order", async () => {
    const center = contextChunks.findIndex((chunk) => chunk.content.includes("widgets"));
    expect(center).toBeGreaterThan(0);
    expect(center).toBeLessThan(contextChunks.length - 1);
    const response = await rpc("tools/call", {
      name: "get_chunk",
      arguments: { chunk_id: contextChunks[center]!.id, before: 1, after: 1 },
    });
    const result = JSON.parse(
      (response.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ) as { items: Array<{ id: string }> };
    expect(result.items.map((chunk) => chunk.id)).toEqual(
      contextChunks.slice(center - 1, center + 2).map((chunk) => chunk.id),
    );
  });

  test("MCP rejects invalid limits, neighbor counts, and document expansion", async () => {
    for (const [name, args] of [
      ["search_documents", { query: "widgets", limit: 0 }],
      ["search_documents", { query: "widgets", limit: 21 }],
      ["list_documents", { limit: 0 }],
      ["list_documents", { limit: 101 }],
      ["get_chunk", { chunk_id: contextChunks[0]!.id, before: -1 }],
      ["get_chunk", { chunk_id: contextChunks[0]!.id, after: 6 }],
      ["search_documents", { query: "widgets", expand: { type: "document" } }],
    ] as const) {
      const response = await rpc("tools/call", { name, arguments: args });
      expect((response.body as { result: { isError?: boolean } }).result.isError).toBe(true);
    }
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
