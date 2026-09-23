import { expect, test, spyOn } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import { createKnowledgeRepository } from "../../packages/db/src/index.ts";
import * as core from "../../packages/core/src/index.ts";

type App = Awaited<ReturnType<typeof createApp>>;
type Page = { corpusVersion: string; items: Array<Record<string, unknown>>; nextCursor?: string; unchanged?: boolean };

async function fixture(run: (app: App, repo: ReturnType<typeof createKnowledgeRepository>, client: Client) => Promise<void>, authenticated = false) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-catalog-api-"));
  const url = `file:${join(dir, "app.db")}`;
  const app = await createApp(loadEnv({ ROLE: "api", DATABASE_URL: url, STORAGE_PATH: join(dir, "blobs"),
    MAX_LIST_LIMIT: "2", ...(authenticated ? { DASHBOARD_PASSPHRASE: "catalog-test-password" } : {}) }));
  const client = createClient({ url });
  try { await run(app, createKnowledgeRepository(url), client); }
  finally { app.stop(); client.close(); await rm(dir, { recursive: true, force: true }); }
}

async function seed(repo: ReturnType<typeof createKnowledgeRepository>, id: string, metadata: Record<string, unknown> = {}, collectionId?: string) {
  await repo.createDocument({ documentId: id, revisionId: `rev_${id}`, originalFilename: `${id}.md`,
    mimeType: "text/markdown", sizeBytes: 1, sha256: `hash-${id}`, metadata, storageKey: `secret/${id}`, collectionId });
  await repo.setDocumentStatus(id, "ready", null, `Title ${id}`);
}

function rest(app: App, query: Record<string, string> = {}, headers: HeadersInit = {}) {
  return app.fetch(new Request(`http://localhost/api/v1/document-catalog?${new URLSearchParams(query)}`, { headers }));
}

function rpc(app: App, method: string, params: unknown, headers: HeadersInit = {}) {
  return app.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
}

async function mcp(app: App, args: Record<string, unknown> = {}) {
  const response = await rpc(app, "tools/call", { name: "list_document_catalog", arguments: args });
  const body = await response.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return body.result;
}

test("catalog pages all duplicate timestamps with REST/MCP parity and the safe default projection", async () => {
  await fixture(async (app, repo, client) => {
    for (const id of ["a", "b", "c", "d", "e"]) await seed(repo, id, { sourcePath: `guides/${id}.md` });
    await client.execute("UPDATE documents SET created_at = 1000");
    const ids: unknown[] = [];
    let cursor: string | undefined;
    let version: string | undefined;
    do {
      const response = await rest(app, cursor ? { cursor } : {});
      expect(response.status).toBe(200);
      const page = await response.json() as Page;
      expect(JSON.parse((await mcp(app, cursor ? { cursor } : {})).content[0]!.text)).toEqual(page);
      expect(page.corpusVersion).toMatch(/^generation:\d+$/);
      if (version) expect(page.corpusVersion).toBe(version);
      version = page.corpusVersion;
      for (const item of page.items) {
        expect(Object.keys(item).sort()).toEqual(["id", "metadata", "revisionId", "sourcePath", "title"]);
        expect(item.sourcePath).toBe(`guides/${item.id}.md`);
      }
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      expect(ids.length).toBeLessThanOrEqual(5);
    } while (cursor);
    expect(ids).toEqual(["e", "d", "c", "b", "a"]);
  });
});

test("catalog applies status, collection, metadata filters and unusual safe projections equally", async () => {
  await fixture(async (app, repo) => {
    const collection = await repo.createCollection({ name: "Guides" });
    await seed(repo, "a", { documentType: "guide", year: 2026, nested: { enabled: true } }, collection.id);
    await seed(repo, "b", { documentType: "other" }, collection.id);
    await seed(repo, "c", { documentType: "guide" });
    await repo.setDocumentStatus("a", "failed");
    const filters = { documentType: "guide", year: { gte: 2025 }, "nested.enabled": true };
    const response = await rest(app, { status: "failed", collectionId: collection.id, filters: JSON.stringify(filters), fields: "updatedAt,status" });
    expect(response.status).toBe(200);
    const page = await response.json() as Page;
    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]!).sort()).toEqual(["status", "updatedAt"]);
    expect(page.items[0]!.status).toBe("failed");
    expect(page.items[0]!.updatedAt).toBeString();
    expect(JSON.parse((await mcp(app, { status: "failed", collection_id: collection.id, filters, fields: ["updatedAt", "status"] })).content[0]!.text)).toEqual(page);
    const minimal = await rest(app, { fields: "id,id" });
    const minimalPage = await minimal.json() as Page;
    for (const item of minimalPage.items) expect(Object.keys(item)).toEqual(["id"]);
  });
});

test("conditional catalog refresh returns only its version and unchanged through both transports", async () => {
  await fixture(async (app, repo) => {
    await seed(repo, "a");
    const initial = await (await rest(app)).json() as Page;
    const expected = { corpusVersion: initial.corpusVersion, unchanged: true };
    expect(await (await rest(app, { ifCorpusVersion: initial.corpusVersion })).json()).toEqual(expected);
    expect(JSON.parse((await mcp(app, { if_corpus_version: initial.corpusVersion })).content[0]!.text)).toEqual(expected);
    for (const status of ["processing", "ready", "failed", "ready"] as const) {
      const previous = await (await rest(app)).json() as Page;
      await repo.setDocumentStatus("a", status);
      const changed = await (await rest(app, { ifCorpusVersion: previous.corpusVersion })).json() as Page;
      expect(changed.corpusVersion).not.toBe(previous.corpusVersion);
      expect(changed.unchanged).toBeUndefined();
      expect(changed.items).toHaveLength(status === "ready" ? 1 : 0);
    }
    const beforeDelete = await (await rest(app)).json() as Page;
    await repo.softDeleteDocument("a");
    const deleted = await (await rest(app, { ifCorpusVersion: beforeDelete.corpusVersion })).json() as Page;
    expect(deleted.corpusVersion).not.toBe(beforeDelete.corpusVersion);
    expect(deleted.items).toEqual([]);
  });
});

test("catalog reports a changed generation across pages so consumers can restart their refresh", async () => {
  await fixture(async (app, repo, client) => {
    for (const id of ["a", "b", "c"]) await seed(repo, id);
    await client.execute("UPDATE documents SET created_at = 1000");
    const first = await (await rest(app, { limit: "1" })).json() as Page;
    expect(first.items.map((item) => item.id)).toEqual(["c"]);
    await repo.setDocumentStatus("b", "failed");
    const second = await (await rest(app, { cursor: first.nextCursor!, limit: "1" })).json() as Page;
    expect(second.corpusVersion).not.toBe(first.corpusVersion);
    expect(second.items.map((item) => item.id)).toEqual(["a"]);
    const restarted = await (await rest(app, { ifCorpusVersion: first.corpusVersion })).json() as Page;
    expect(restarted.items.map((item) => item.id)).toEqual(["c", "a"]);
  });
});

test("REST and MCP return stable catalog errors for malformed arguments", async () => {
  await fixture(async (app) => {
    const cases: Array<[Record<string, string>, Record<string, unknown>, string]> = [
      [{ limit: "0" }, { limit: 0 }, "INVALID_ARGUMENT"],
      [{ limit: "1.5" }, { limit: 1.5 }, "INVALID_ARGUMENT"],
      [{ limit: "3" }, { limit: 3 }, "INVALID_ARGUMENT"],
      [{ limit: "NaN" }, { limit: "NaN" }, "INVALID_ARGUMENT"],
      [{ limit: "" }, { limit: null }, "INVALID_ARGUMENT"],
      [{ status: "unknown" }, { status: "unknown" }, "INVALID_ARGUMENT"],
      [{ collectionId: "" }, { collection_id: "" }, "INVALID_ARGUMENT"],
      [{ cursor: "!" }, { cursor: "!" }, "INVALID_CURSOR"],
      [{ cursor: "" }, { cursor: "" }, "INVALID_CURSOR"],
      [{ fields: "sha256" }, { fields: ["sha256"] }, "INVALID_PROJECTION"],
      [{ fields: "storageKey" }, { fields: ["storageKey"] }, "INVALID_PROJECTION"],
      [{ fields: "__proto__" }, { fields: ["__proto__"] }, "INVALID_PROJECTION"],
      [{ fields: "" }, { fields: [] }, "INVALID_PROJECTION"],
      [{ filters: "[]" }, { filters: [] }, "INVALID_FILTER"],
      [{ filters: '{"bad.path!":1}' }, { filters: { "bad.path!": 1 } }, "INVALID_FILTER"],
      [{ filters: '{"year":{"gte":[]}}' }, { filters: { year: { gte: [] } } }, "INVALID_FILTER"],
    ];
    for (const value of ["", "sha256:abc", "generation:-1", "generation:1.5", "generation:01", "generation:1e2", "generation:9007199254740992", "generation:1\n"]) {
      cases.push([{ ifCorpusVersion: value }, { if_corpus_version: value }, "INVALID_CORPUS_VERSION"]);
    }
    for (const [query, args, code] of cases) {
      const response = await rest(app, query);
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
      const result = await mcp(app, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toStartWith(`${code}:`);
    }
    const malformed = await rest(app, { filters: "{" });
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as { error: { code: string } }).error.code).toBe("INVALID_FILTER");
    for (const args of [{ limit: true }, { limit: "1" }, { cursor: 42 }, { status: [] }, { collection_id: {} }, { fields: "id" }, { fields: [null] }, { if_corpus_version: 1 }]) {
      expect((await mcp(app, args)).isError).toBe(true);
    }
  });
});

test("catalog tool advertises all supported fields without changing list_documents", async () => {
  await fixture(async (app, repo) => {
    const body = await (await rpc(app, "tools/list", {})).json() as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } };
    const schema = body.result.tools.find((tool) => tool.name === "list_document_catalog")?.inputSchema;
    expect(schema).toBeDefined();
    expect(Object.keys(schema!.properties).sort()).toEqual(["collection_id", "cursor", "fields", "filters", "if_corpus_version", "limit", "status"]);
    expect(schema!.properties.limit).toEqual({ type: "integer", minimum: 1, maximum: 2 });
    expect(schema!.properties.fields).toEqual({ type: "array", minItems: 1, items: { type: "string", enum: ["id", "revisionId", "title", "sourcePath", "metadata", "status", "updatedAt"] } });
    expect(Object.keys(body.result.tools.find((tool) => tool.name === "list_documents")!.inputSchema.properties).sort())
      .toEqual(["collection_id", "cursor", "limit", "status"]);
    await seed(repo, "legacy");
    const legacy = await (await rpc(app, "tools/call", { name: "list_documents", arguments: {} })).json() as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(legacy.result.content[0]!.text);
    expect(payload.corpusVersion).toBeUndefined();
    expect(payload.items[0].sha256).toBe("hash-legacy");
  });
});

test("both catalog transports require authentication and accept the existing read scope", async () => {
  await fixture(async (app) => {
    expect((await rest(app)).status).toBe(401);
    expect((await rpc(app, "tools/call", { name: "list_document_catalog" })).status).toBe(401);
    const { secret } = await app.services.keys.create({ name: "reader", scopes: ["read"] });
    const headers = { authorization: `Bearer ${secret}` };
    expect((await rest(app, {}, headers)).status).toBe(200);
    const allowed = await rpc(app, "tools/call", { name: "list_document_catalog" }, headers);
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  }, true);
});

test("service validates before repository access and skips the page query for an equal version", async () => {
  await fixture(async (_app, repo) => {
    expect(core.DocumentCatalogService).toBeDefined();
    const catalog = new core.DocumentCatalogService(repo, 2);
    const generation = await repo.getCorpusGeneration();
    const reads = spyOn(repo, "getCorpusGeneration");
    const pages = spyOn(repo, "listDocumentCatalog");
    try {
      for (const [input, code] of [
        [{ fields: ["storageKey"] }, "INVALID_PROJECTION"],
        [{ filters: { year: { gte: [] } } }, "INVALID_FILTER"],
        [{ limit: 0 }, "INVALID_ARGUMENT"],
        [{ status: null }, "INVALID_ARGUMENT"],
        [{ collectionId: 42 }, "INVALID_ARGUMENT"],
        [{ cursor: 42 }, "INVALID_CURSOR"],
        [{ ifCorpusVersion: null }, "INVALID_CORPUS_VERSION"],
      ] as const) {
        await expect(catalog.list(input)).rejects.toMatchObject({ code, status: 400 });
      }
      expect(reads).not.toHaveBeenCalled();
      expect(pages).not.toHaveBeenCalled();
      expect(await catalog.list({ ifCorpusVersion: `generation:${generation}` }))
        .toEqual({ corpusVersion: `generation:${generation}`, unchanged: true });
      expect(pages).not.toHaveBeenCalled();
      const result = await catalog.list({ ifCorpusVersion: "generation:9007199254740991" });
      expect(result).toMatchObject({ corpusVersion: `generation:${generation}`, items: [] });
      expect(pages).toHaveBeenCalledTimes(1);
    } finally { reads.mockRestore(); pages.mockRestore(); }
  });
});

test("a mutation during the page read cannot label stale rows with a later generation", async () => {
  await fixture(async (_app, repo) => {
    expect(core.DocumentCatalogService).toBeDefined();
    await seed(repo, "a");
    const generation = await repo.getCorpusGeneration();
    let mutate = true;
    const catalog = new core.DocumentCatalogService({
      getCorpusGeneration: () => repo.getCorpusGeneration(),
      listDocumentCatalog: async (query) => {
        const page = await repo.listDocumentCatalog(query);
        if (mutate) { mutate = false; await repo.setDocumentStatus("a", "failed"); }
        return page;
      },
    }, 2);
    const raced = await catalog.list({});
    expect(raced).toMatchObject({ corpusVersion: `generation:${generation}`, items: [{ id: "a" }] });
    const refreshed = await catalog.list({ ifCorpusVersion: raced.corpusVersion });
    expect(refreshed.corpusVersion).not.toBe(raced.corpusVersion);
    expect(refreshed).toMatchObject({ items: [] });
  });
});
