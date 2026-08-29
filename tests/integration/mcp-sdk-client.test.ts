import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

// Regression: tests/integration/mcp.test.ts only ever drove /mcp with raw fetch() simulating
// JSON-RPC by hand - it never proved a real MCP client (the thing Gate A's own checklist
// requires: "MCP search_documents from Cursor/Claude against /mcp") could actually talk to
// this server. Verified manually with the official SDK client before adding this: it works,
// but that verification is worthless if it isn't a test that runs again on the next change.
describe("MCP via the real SDK client", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-sdk-"));
    const env = loadEnv({
      AUTH_DISABLED: "true",
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    const app = await createApp(env);
    stop = app.stop;
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
    const form = new FormData();
    form.set("file", new File(["# Hello\n\nSearchable paragraph about widgets."], "n.md"));
    const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    const body = (await created.json()) as { id: string };
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const doc = (await (await fetch(`${base}/api/v1/documents/${body.id}`)).json()) as { status: string };
      if (doc.status === "ready") break;
      await Bun.sleep(50);
    }
  }, 60_000);

  afterAll(async () => {
    stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("connects, lists tools, and calls search_documents", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    const client = new Client({ name: "test-client", version: "1.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("search_documents");

      const result = await client.callTool({
        name: "search_documents",
        arguments: { query: "widgets", limit: 5 },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      const hits = JSON.parse(content[0]!.text) as Array<{ documentId: string; resourceUri: string }>;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.resourceUri.startsWith("document://")).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
