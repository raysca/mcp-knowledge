import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import { SearchService } from "../../packages/core/src/services/search-service.ts";
import type { Embedder, KnowledgeRepository, LexicalHit, LexicalIndex, VectorHit, VectorIndex } from "../../packages/core/src/ports.ts";

async function waitReady(base: string, id: string, ms = 60_000) {
  const start = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - start < ms) {
    const res = await fetch(`${base}/api/v1/documents/${id}`);
    const doc = (await res.json()) as { status?: string; latestError?: string };
    if (doc.status === "ready") return doc;
    lastStatus = `${doc.status}: ${doc.latestError ?? ""}`;
    if (doc.status === "failed") throw new Error(`document ${id} failed: ${lastStatus}`);
    await Bun.sleep(50);
  }
  throw new Error(`document ${id} timed out: ${lastStatus}`);
}

describe("hybrid search", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;
  let invoiceId = "";
  let chunkId = "";
  const matchingDocuments: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-hybrid-"));
    const env = loadEnv({
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    const app = await createApp(env);
    stop = app.stop;
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
    const form = new FormData();
    form.set(
      "file",
      new File(["# Invoices\n\nPayment for invoice INV-0042 is due in thirty days.\n"], "inv.md"),
    );
    const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
    const json = (await created.json()) as { id: string };
    invoiceId = json.id;
    await waitReady(base, invoiceId);
    const chunks = await fetch(`${base}/api/v1/documents/${invoiceId}/chunks`);
    const listed = (await chunks.json()) as { items: Array<{ id: string }> };
    chunkId = listed.items[0]!.id;
    for (const [filename, content] of [
      ["dominant.md", Array.from({ length: 3 }, (_, i) => `# Part ${i}\n\n${"marigold planting ".repeat(45)} section ${i}`).join("\n\n")],
      ["other-one.md", `# Garden One\n\n${"marigold planting ".repeat(45)}`],
      ["other-two.md", `# Garden Two\n\n${"marigold planting ".repeat(45)}`],
    ]) {
      const upload = new FormData();
      upload.set("file", new File([content], filename));
      const response = await fetch(`${base}/api/v1/documents`, { method: "POST", body: upload });
      const createdDocument = (await response.json()) as { id: string };
      matchingDocuments.push(createdDocument.id);
      await waitReady(base, createdDocument.id);
    }
  }, 60_000);

  afterAll(async () => {
    stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("lexical mode finds INV-0042", async () => {
    const res = await fetch(`${base}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "INV-0042", mode: "lexical", limit: 8 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ documentId: string; ranking: { lexicalRank?: number } }> };
    expect(body.hits[0]?.documentId).toBe(invoiceId);
    expect(body.hits[0]?.ranking.lexicalRank).toBe(1);
  });

  test("lexical mode supports prefix wildcard searches", async () => {
    const res = await fetch(`${base}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "INV-004*", mode: "lexical", limit: 8 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ documentId: string }> };
    expect(body.hits.some((h) => h.documentId === invoiceId)).toBe(true);
  });

  test("explain includes timings and fusion fields", async () => {
    const res = await fetch(`${base}/api/v1/search/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "invoice payment", mode: "hybrid", limit: 8 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ ranking: { fusionScore?: number } }>;
      timings: { totalMs: number; lexicalSearchMs: number };
      matchedTerms: string[];
    };
    expect(body.hits[0]?.ranking.fusionScore).toBeGreaterThan(0);
    expect(body.timings.totalMs).toBeGreaterThan(0);
    expect(body.matchedTerms.length).toBeGreaterThan(0);
  });

  test("REST document collapse returns distinct documents and keeps omitted chunk shape", async () => {
    const search = async (collapse?: string) => {
      const response = await fetch(`${base}/api/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "marigold", mode: "lexical", limit: 3, ...(collapse ? { collapse } : {}) }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { hits: Array<{
        documentId: string; matchingChunkCount?: number; matchedHeadings?: string[];
        ranking: { finalRank: number; chunkRank?: number };
      }> };
    };
    const chunks = await search();
    const explicitNone = await search("none");
    const documents = await search("document");
    expect(explicitNone).toEqual(chunks);
    expect(chunks.hits[0]).not.toHaveProperty("matchingChunkCount");
    expect(documents.hits.length).toBeGreaterThan(1);
    expect(new Set(documents.hits.map((hit) => hit.documentId)).size).toBe(documents.hits.length);
    expect(documents.hits.every((hit) => matchingDocuments.includes(hit.documentId))).toBe(true);
    expect(documents.hits[0]!.matchingChunkCount).toBeGreaterThanOrEqual(1);
    expect(documents.hits[0]!.ranking.chunkRank).toBeGreaterThanOrEqual(1);
  });

  test("REST explain preserves diagnostics for document collapse", async () => {
    const response = await fetch(`${base}/api/v1/search/explain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "marigold", mode: "lexical", limit: 2, collapse: "document" }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { hits: Array<{ documentId: string; matchingChunkCount: number }>;
      lexical: unknown[]; vector: unknown[]; timings: { fusionMs: number } };
    expect(result.hits.map((hit) => hit.documentId)).toEqual([...new Set(result.hits.map((hit) => hit.documentId))]);
    expect(result.lexical.length).toBeGreaterThanOrEqual(result.hits.length);
    expect(result.vector).toEqual([]);
    expect(result.timings.fusionMs).toBeGreaterThanOrEqual(0);
  });

  test("REST rejects unsupported collapse modes with a public error", async () => {
    for (const endpoint of ["/api/v1/search", "/api/v1/search/explain"]) {
      const response = await fetch(`${base}${endpoint}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "marigold", collapse: "paragraph" }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "SEARCH_COLLAPSE_UNSUPPORTED" },
      });
    }
  });

  test("GET /chunks/:id returns neighbors", async () => {
    const res = await fetch(`${base}/api/v1/chunks/${chunkId}?before=1&after=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.some((c) => c.id === chunkId)).toBe(true);
  });
});

describe("document collapse candidate pools", () => {
  const candidate = (chunkId: string, documentId: string, rank: number) => ({
    chunkId, documentId, revisionId: `rev-${documentId}`, title: documentId,
    content: `${chunkId} content`, headingPath: [chunkId], score: 1 / rank,
  });
  const rows = [
    candidate("a1", "a", 1), candidate("a2", "a", 2), candidate("a3", "a", 3),
    candidate("b1", "b", 4), candidate("c1", "c", 5),
  ];
  const seen = { vectorLimits: [] as number[], lexicalLimits: [] as number[], revisions: [] as string[], filters: [] as unknown[] };
  const embedder: Embedder = { name: "fixture", model: "fixture", version: "1", dimensions: 1,
    embed: async () => [[1]] };
  const vectors: VectorIndex = { insert: async () => {}, deleteRevision: async () => {},
    search: async (input) => {
    seen.vectorLimits.push(input.limit);
    seen.filters.push(input.filters);
    return rows.slice(0, input.limit).map((row, i) => ({ ...row, vectorRank: i + 1, vectorScore: row.score })) as VectorHit[];
  } };
  const lexical: LexicalIndex = { search: async (input) => {
    seen.lexicalLimits.push(input.limit);
    seen.filters.push(input.filters);
    return rows.slice(0, input.limit).map((row, i) => ({ ...row, lexicalRank: i + 1, lexicalScore: row.score })) as LexicalHit[];
  } };
  const repo = { listRevisionChunks: async (revisionId: string) => {
    seen.revisions.push(revisionId);
    const row = rows.find((candidateRow) => candidateRow.revisionId === revisionId)!;
    return [{ id: row.chunkId, sequence: 0, content: row.content, headingPath: row.headingPath }];
  } } as KnowledgeRepository;
  const service = new SearchService(embedder, vectors, lexical, repo, {
    VECTOR_CANDIDATES: 5, LEXICAL_CANDIDATES: 5, RRF_K: 60,
  });

  test("all search modes collapse the full bounded pool before requested-limit slicing", async () => {
    for (const mode of ["vector", "lexical", "hybrid"] as const) {
      seen.vectorLimits.length = 0;
      seen.lexicalLimits.length = 0;
      const result = await service.search({ query: "garden", mode, collapse: "document", limit: 3 });
      expect(result.hits.map((hit) => hit.documentId)).toEqual(["a", "b", "c"]);
      expect(result.hits[0]).toMatchObject({ matchingChunkCount: 3, matchedHeadings: ["a1", "a2", "a3"] });
      expect(seen.vectorLimits).toEqual(mode === "lexical" ? [] : [5]);
      expect(seen.lexicalLimits).toEqual(mode === "vector" ? [] : [5]);
    }
  });

  test("collapsed expansion loads only representative revisions and forwards filters", async () => {
    seen.revisions.length = 0;
    seen.filters.length = 0;
    const result = await service.search({ query: "garden", mode: "hybrid", collapse: "document", limit: 2,
      filters: { category: "garden" }, expand: { type: "section" } });
    expect(result.hits.map((hit) => hit.documentId)).toEqual(["a", "b"]);
    expect(seen.revisions).toEqual(["rev-a", "rev-b"]);
    expect(seen.filters).toEqual([[{ field: "category", op: "eq", value: "garden" }],
      [{ field: "category", op: "eq", value: "garden" }]]);
  });

  test("collapse may return fewer distinct documents than requested within its bounded pool", async () => {
    const bounded = new SearchService(embedder, vectors, lexical, repo, {
      VECTOR_CANDIDATES: 4, LEXICAL_CANDIDATES: 4, RRF_K: 60,
    });
    const result = await bounded.search({ query: "garden", mode: "hybrid", collapse: "document", limit: 3 });
    expect(result.hits.map((hit) => hit.documentId)).toEqual(["a", "b"]);
  });

  test("collapse adaptively expands candidate pool when distinct documents are dominated by a single document", async () => {
    seen.vectorLimits.length = 0;
    seen.lexicalLimits.length = 0;
    const adaptive = new SearchService(embedder, vectors, lexical, repo, {
      VECTOR_CANDIDATES: 4, LEXICAL_CANDIDATES: 4, MAX_COLLAPSE_CANDIDATES: 10, RRF_K: 60,
    });
    const result = await adaptive.search({ query: "garden", mode: "hybrid", collapse: "document", limit: 3 });
    expect(result.hits.map((hit) => hit.documentId)).toEqual(["a", "b", "c"]);
    expect(seen.vectorLimits).toEqual([4, 9]);
    expect(seen.lexicalLimits).toEqual([4, 9]);
  });

  test("omitted collapse retains requested pool sizes and chunk result fields", async () => {
    for (const mode of ["vector", "lexical"] as const) {
      seen.vectorLimits.length = 0;
      seen.lexicalLimits.length = 0;
      const omitted = await service.search({ query: "garden", mode, limit: 2 });
      const explicit = await service.search({ query: "garden", mode, collapse: "none", limit: 2 });
      expect(explicit).toEqual(omitted);
      expect(omitted.hits.map((hit) => hit.documentId)).toEqual(["a", "a"]);
      expect(omitted.hits[0]).not.toHaveProperty("matchingChunkCount");
      expect(seen.vectorLimits).toEqual(mode === "vector" ? [2, 2] : []);
      expect(seen.lexicalLimits).toEqual(mode === "lexical" ? [2, 2] : []);
    }
  });

  test("section expansion for headingless preamble chunk does not leak subsequent sections", async () => {
    const preambleRepo = {
      listRevisionChunks: async () => [
        { id: "c0", sequence: 0, content: "Preamble paragraph 1", headingPath: [] },
        { id: "c1", sequence: 1, content: "Preamble paragraph 2", headingPath: [] },
        { id: "c2", sequence: 2, content: "First heading content", headingPath: ["Overview"] },
      ],
    } as unknown as KnowledgeRepository;
    const preambleService = new SearchService(embedder, {
      ...vectors,
      search: async () => [{
        chunkId: "c0", documentId: "doc_preamble", revisionId: "rev_p", title: "Doc",
        content: "Preamble paragraph 1", headingPath: [], score: 1, vectorRank: 1, vectorScore: 1,
      }],
    } as unknown as VectorIndex, lexical, preambleRepo, {
      VECTOR_CANDIDATES: 5, LEXICAL_CANDIDATES: 5, RRF_K: 60,
    });
    const result = await preambleService.search({
      query: "preamble", mode: "vector", limit: 1, expand: { type: "section" },
    });
    expect(result.hits[0]?.content).toBe("Preamble paragraph 1\n\nPreamble paragraph 2");
  });
});
