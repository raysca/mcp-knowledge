import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

describe("documents API", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";

  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-knowledge-"));
    const env = loadEnv({
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
      MAX_UPLOAD_BYTES: "64",
      MAX_MCP_DOCUMENT_CHARS: "145",
    });
    app = await createApp(env);
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    app.stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  function upload(filename: string, body: string | Uint8Array) {
    const form = new FormData();
    form.set("file", new File([body as BlobPart], filename)); // ponytail: same BlobPart lib quirk as document-service.ts
    return fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
  }

  async function readyDocument(filename: string, source: string): Promise<string> {
    const response = await upload(filename, source);
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await fetch(`${base}/api/v1/documents/${id}`);
      const document = (await result.json()) as { status: string };
      if (document.status === "ready") return id;
      if (document.status === "failed") throw new Error(`Ingestion failed for ${id}`);
      await Bun.sleep(50);
    }
    throw new Error(`Ingestion timed out for ${id}`);
  }

  test("health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("upload, list, get, download, delete", async () => {
    const bytes = "hello knowledge\n";
    const created = await upload("note.txt", bytes);
    expect(created.status).toBe(202);
    const body = (await created.json()) as {
      id: string;
      status: string;
      revision: number;
      duplicate: boolean;
    };
    expect(body.id.startsWith("doc_")).toBe(true);
    expect(["processing", "ready"]).toContain(body.status);
    expect(body.revision).toBe(1);
    expect(body.duplicate).toBe(false);

    const list = await fetch(`${base}/api/v1/documents`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { items: Array<{ id: string; status: string }> };
    expect(listed.items.some((d) => d.id === body.id)).toBe(true);

    const got = await fetch(`${base}/api/v1/documents/${body.id}`);
    expect(got.status).toBe(200);
    const doc = (await got.json()) as { originalFilename: string; status: string };
    expect(doc.originalFilename).toBe("note.txt");
    expect(["processing", "ready"]).toContain(doc.status);

    const file = await fetch(`${base}/api/v1/documents/${body.id}/file`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(bytes);

    const del = await fetch(`${base}/api/v1/documents/${body.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const missing = await fetch(`${base}/api/v1/documents/${body.id}`);
    expect(missing.status).toBe(404);
    const err = (await missing.json()) as { error: { code: string } };
    expect(err.error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  test("duplicate live sha256 returns 200", async () => {
    const first = await upload("dup.txt", "same-bytes");
    expect(first.status).toBe(202);
    const a = (await first.json()) as { id: string };
    const second = await upload("dup-again.txt", "same-bytes");
    expect(second.status).toBe(200);
    const b = (await second.json()) as { id: string; duplicate: boolean };
    expect(b.id).toBe(a.id);
    expect(b.duplicate).toBe(true);
  });

  test("oversize upload is 413", async () => {
    const res = await upload("big.txt", "x".repeat(65));
    expect(res.status).toBe(413);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("normalized pages reconstruct uploaded blocks within the character ceiling", async () => {
    const id = await readyDocument("paged.md", "# Tools\nHammer\n# Paint\nPrimer\n# Care\nKeep dry");
    const expected = [
      { type: "heading", level: 1, text: "Tools" },
      { type: "paragraph", text: "Hammer" },
      { type: "heading", level: 1, text: "Paint" },
      { type: "paragraph", text: "Primer" },
      { type: "heading", level: 1, text: "Care" },
      { type: "paragraph", text: "Keep dry" },
    ];
    const blocks: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams({ blockLimit: "2", ...(cursor ? { blockCursor: cursor } : {}) });
      const response = await fetch(`${base}/api/v1/documents/${id}/normalized?${query}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        metadata: Record<string, unknown>; blocks: unknown[];
        truncated: boolean; nextBlockCursor?: string;
        returnedBlocks: number; totalBlocks: number;
      };
      expect(JSON.stringify({ metadata: page.metadata, blocks: page.blocks }).length).toBeLessThanOrEqual(145);
      expect(page.metadata).toEqual({});
      expect(page.returnedBlocks).toBe(page.blocks.length);
      expect(page.totalBlocks).toBe(6);
      blocks.push(...page.blocks);
      cursor = page.nextBlockCursor;
      expect(page.truncated).toBe(Boolean(cursor));
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(blocks).toEqual(expected);
  }, 40_000);

  test("normalized route rejects tampered and cross-document cursors", async () => {
    const first = await readyDocument("cursor-a.md", "# One\nFirst\n# Two\nSecond");
    const second = await readyDocument("cursor-b.md", "# One\nDifferent\n# Two\nLast");
    const firstPage = await fetch(`${base}/api/v1/documents/${first}/normalized?blockLimit=1`);
    expect(firstPage.status).toBe(200);
    const cursor = ((await firstPage.json()) as { nextBlockCursor: string }).nextBlockCursor;
    expect(cursor).toBeTruthy();
    const changed = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
    const tampered = await fetch(`${base}/api/v1/documents/${first}/normalized?blockCursor=${encodeURIComponent(changed)}`);
    expect(tampered.status).toBe(400);
    expect(((await tampered.json()) as { error: { code: string } }).error.code).toBe("INVALID_CURSOR");
    const stale = await fetch(`${base}/api/v1/documents/${second}/normalized?blockCursor=${encodeURIComponent(cursor)}`);
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("CURSOR_STALE");
  }, 40_000);

  test("normalized route applies repeated headings and block limits", async () => {
    const id = await readyDocument("headings.md", "# Tools\nHammer\n# Other\nExclude\n# Tools\nWrench");
    const response = await fetch(`${base}/api/v1/documents/${id}/normalized?heading=Tools&heading=Other&blockLimit=1`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as { blocks: unknown[]; returnedBlocks: number; totalBlocks: number };
    expect(page.returnedBlocks).toBe(1);
    expect(page.totalBlocks).toBe(6);
    const tools = await fetch(`${base}/api/v1/documents/${id}/normalized?heading=Tools&heading=Missing&blockLimit=100000`);
    expect(tools.status).toBe(200);
    const filtered = (await tools.json()) as { blocks: Array<{ text: string }>; totalBlocks: number; nextBlockCursor?: string };
    expect(filtered.totalBlocks).toBe(4);
    const texts = filtered.blocks.map((block) => block.text);
    let cursor = filtered.nextBlockCursor;
    let pages = 0;
    while (cursor) {
      const next = await fetch(`${base}/api/v1/documents/${id}/normalized?heading=Tools&heading=Missing&blockLimit=100000&blockCursor=${encodeURIComponent(cursor)}`);
      expect(next.status).toBe(200);
      const page = (await next.json()) as { blocks: Array<{ text: string }>; nextBlockCursor?: string };
      texts.push(...page.blocks.map((block) => block.text));
      cursor = page.nextBlockCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    }
    expect(texts).toEqual(["Tools", "Hammer", "Tools", "Wrench"]);
  }, 40_000);

  test("a small normalized REST response keeps its original top-level fields", async () => {
    const id = await readyDocument("small-compatible.md", "# Guide\nHelpful text");
    const response = await fetch(`${base}/api/v1/documents/${id}/normalized`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      metadata: Record<string, unknown>;
      blocks: Array<{ type: string; text: string; level?: number }>;
      body?: string;
      truncated: boolean;
      returnedBlocks: number;
      totalBlocks: number;
    };
    expect(page.metadata).toEqual({});
    expect(page.blocks).toEqual([
      { type: "heading", level: 1, text: "Guide" },
      { type: "paragraph", text: "Helpful text" },
    ]);
    expect(page.body).toBeUndefined();
    expect(page.truncated).toBe(false);
    expect(page.returnedBlocks).toBe(2);
    expect(page.totalBlocks).toBe(2);
  }, 40_000);

  test("normalized route caps a caller's block limit at the configured maximum", async () => {
    const id = await readyDocument("clamped.md", "# One\nFirst\n# Two\nSecond\n# Three\nThird");
    const capped = await createApp(loadEnv({
      ROLE: "api",
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
      MAX_LIST_LIMIT: "2",
      MAX_MCP_DOCUMENT_CHARS: "2000",
    }));
    try {
      const response = await capped.fetch(new Request(`http://localhost/api/v1/documents/${id}/normalized?blockLimit=100000`));
      expect(response.status).toBe(200);
      const page = (await response.json()) as { returnedBlocks: number; totalBlocks: number; truncated: boolean };
      expect(page.returnedBlocks).toBe(2);
      expect(page.totalBlocks).toBe(6);
      expect(page.truncated).toBe(true);
    } finally {
      capped.stop();
    }
  }, 40_000);

  test("omitted block limits return the same full small document through REST and MCP", async () => {
    const id = await readyDocument("shared-omission.md", "# Maple\nLeaf\n# Oak\nBark\n# Pine\nCone");
    const smallLimitApp = await createApp(loadEnv({
      ROLE: "api",
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
      MAX_LIST_LIMIT: "2",
      MAX_MCP_DOCUMENT_CHARS: "2000",
    }));
    try {
      const rest = await smallLimitApp.fetch(new Request(`http://localhost/api/v1/documents/${id}/normalized`));
      expect(rest.status).toBe(200);
      const restPage = (await rest.json()) as { blocks: unknown[]; returnedBlocks: number; truncated: boolean };
      const mcp = await smallLimitApp.fetch(new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "get_document", arguments: { document_id: id },
        } }),
      }));
      expect(mcp.status).toBe(200);
      const result = (await mcp.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      expect(result.result.isError).toBeUndefined();
      const mcpPage = JSON.parse(result.result.content[0]!.text) as { body: string; returnedBlocks: number; truncated: boolean };
      expect(restPage.returnedBlocks).toBe(6);
      expect(restPage.truncated).toBe(false);
      expect(mcpPage.returnedBlocks).toBe(6);
      expect(mcpPage.truncated).toBe(false);
      expect((JSON.parse(mcpPage.body) as { blocks: unknown[] }).blocks).toEqual(restPage.blocks);
    } finally {
      smallLimitApp.stop();
    }
  }, 40_000);

  test("REST and MCP sanitize malformed stored headings", async () => {
    const id = await readyDocument("corrupt-heading.md", "# Original\nContent");
    const document = (await (await fetch(`${base}/api/v1/documents/${id}`)).json()) as { currentRevisionId: string };
    const path = join(dir, "blobs", "documents", id, "revisions", document.currentRevisionId, "normalized.json");
    for (const heading of [
      { type: "heading", level: 1 },
      { type: "heading", level: 1, text: 42 },
      { type: "heading", level: "one", text: "Original" },
      { type: "heading", level: 0, text: "Original" },
    ]) {
      await writeFile(path, JSON.stringify({ metadata: {}, blocks: [heading, { type: "paragraph", text: "Content" }] }));
      const rest = await fetch(`${base}/api/v1/documents/${id}/normalized?heading=Original`);
      expect(rest.status).toBe(500);
      const restBody = (await rest.json()) as { error: { code: string; message: string } };
      expect(restBody.error).toMatchObject({
        code: "DOCUMENT_CONTENT_UNAVAILABLE",
        message: "Normalized document content is unavailable.",
      });
      const mcp = await app.fetch(new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name: "get_document", arguments: { document_id: id, headings: ["Original"] },
        } }),
      }));
      const mcpResult = (await mcp.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      expect(mcpResult.result.isError).toBe(true);
      expect(mcpResult.result.content[0]!.text)
        .toBe("DOCUMENT_CONTENT_UNAVAILABLE: Normalized document content is unavailable.");
    }
  }, 40_000);

  test("independent cursor secret survives app recreation and password guesses cannot verify it", async () => {
    const id = await readyDocument("persistent-cursor.md", "# One\nPersisted\n# Two\nSecond");
    const secret = Buffer.alloc(32, 0x45).toString("base64");
    const settings = {
      ROLE: "api",
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
      DASHBOARD_PASSPHRASE: "correct-horse-battery-staple",
      DOCUMENT_CURSOR_SECRET: secret,
      MAX_MCP_DOCUMENT_CHARS: "145",
    };
    const first = await createApp(loadEnv(settings));
    let cursor: string | undefined;
    try {
      const page = await first.services.documents.normalizedPage(id, { blockLimit: 1, maxChars: 145 });
      cursor = page.nextBlockCursor;
      expect(cursor).toBeTruthy();
      const [payload, mac] = cursor!.split(".");
      for (const candidate of ["password", settings.DASHBOARD_PASSPHRASE, "another-secret"]) {
        expect(createHmac("sha256", candidate).update(payload!).digest("base64url")).not.toBe(mac);
        const guessedKey = createHmac("sha256", candidate)
          .update("mcp-knowledge:document-block-cursor:v1").digest();
        expect(createHmac("sha256", guessedKey).update(payload!).digest("base64url")).not.toBe(mac);
      }
    } finally {
      first.stop();
    }
    const second = await createApp(loadEnv(settings));
    try {
      const denied = await second.fetch(new Request(`http://localhost/api/v1/documents/${id}/normalized`));
      expect(denied.status).toBe(401);
      const page = await second.services.documents.normalizedPage(id, { cursor, maxChars: 145 });
      expect((JSON.parse(page.body) as { blocks: Array<{ text: string }> }).blocks[0]?.text).toBe("Persisted");
    } finally {
      second.stop();
    }
    const changedPassword = await createApp(loadEnv({ ...settings, DASHBOARD_PASSPHRASE: "another-secret" }));
    try {
      const page = await changedPassword.services.documents.normalizedPage(id, { cursor, maxChars: 145 });
      expect((JSON.parse(page.body) as { blocks: Array<{ text: string }> }).blocks[0]?.text).toBe("Persisted");
    } finally {
      changedPassword.stop();
    }
    const changedSecret = await createApp(loadEnv({ ...settings, DOCUMENT_CURSOR_SECRET: Buffer.alloc(32, 0x46).toString("base64") }));
    try {
      await expect(changedSecret.services.documents.normalizedPage(id, { cursor, maxChars: 145 }))
        .rejects.toMatchObject({ code: "INVALID_CURSOR" });
    } finally {
      changedSecret.stop();
    }
  }, 40_000);
});
