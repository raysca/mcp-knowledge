import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../packages/core/src/logger.ts";
import { SearchService } from "../../packages/core/src/services/search-service.ts";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";
import { LibsqlLexicalIndex } from "../../packages/retrieval/src/lexical/libsql-fts.ts";

describe("title-aware lexical fallback", () => {
  let dir: string;
  let url: string;
  let client: Client;
  let index: LibsqlLexicalIndex;
  let repo: ReturnType<typeof createKnowledgeRepository>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-lexical-fallback-"));
    url = `file:${join(dir, "app.db")}`;
    await migrateLibsql(url);
    client = createClient({ url });
    repo = createKnowledgeRepository(url);
    index = new LibsqlLexicalIndex(url);
  });
  afterEach(async () => {
    client.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function add(id: string, content: string, title = "", headingPath: string[] = []) {
    await repo.createDocument({ documentId: id, revisionId: `rev-${id}`, originalFilename: `${id}.md`,
      mimeType: "text/markdown", sizeBytes: 1, sha256: id, metadata: {}, storageKey: id });
    await repo.setDocumentStatus(id, "ready", null, title);
    await repo.replaceChunks(`rev-${id}`, [{ id: `chk-${id}`, documentId: id, revisionId: `rev-${id}`,
      sequence: 0, content, embeddingText: content, headingPath, tokenCount: 1,
      metadata: {}, contentHash: id, createdAt: new Date() }]);
  }
  const ids = (hits: Awaited<ReturnType<LibsqlLexicalIndex["search"]>>) => hits.map((hit) => hit.documentId);

  test("title-only, heading-only and body-only matches rank in that order", async () => {
    await add("title", "ordinary content", "marigold");
    await add("heading", "ordinary content", "", ["marigold"]);
    await add("body", "marigold content");
    expect(ids(await index.search({ query: "marigold", limit: 3 }))).toEqual(["title", "heading", "body"]);
  });

  test("noisy speech fills missing exact results with labeled, bounded fallback hits", async () => {
    await add("garden", "raised garden bed");
    const hits = await index.search({ query: "please can you help me with a raised garden bed", limit: 1 });
    expect(ids(hits)).toEqual(["garden"]);
    expect(hits[0]).toMatchObject({ lexicalMatchMode: "fallback", lexicalRank: 1 });
  });

  test("three eligible terms require two distinct matches, including across title and body", async () => {
    await add("two", "garden", "raised");
    await add("one", "raised raised raised");
    expect(ids(await index.search({ query: "raised garden bed", limit: 8 }))).toEqual(["two"]);
    expect(ids(await index.search({ query: "raised RAISED garden missing", limit: 8 }))).toEqual(["two"]);
  });

  test("two eligible terms may fall back to one match", async () => {
    await add("garden", "garden");
    expect(ids(await index.search({ query: "garden unavailable", limit: 8 }))).toEqual(["garden"]);
  });

  for (const term of ["λέξη", "ộ", "बीज"]) {
    test(`fallback preserves the searchable Unicode spelling of ${term}`, async () => {
      await add("unicode", `${term} garden`);
      const hits = await index.search({ query: `${term} garden missing`, limit: 8 });
      expect(ids(hits)).toEqual(["unicode"]);
      expect(hits[0]).toMatchObject({ lexicalMatchMode: "fallback" });
    });
  }

  for (const term of ["λέξη", "ộ", "बीज", "café"]) {
    test(`canonical and repeated variants of ${term} count as one eligible term`, async () => {
      await add("one", `${term} ${term.normalize("NFD")}`);
      await add("two", `${term} garden`);
      for (const variants of [
        `${term} ${term.toUpperCase()} ${term.normalize("NFD")}`,
        `${term.normalize("NFD")} ${term} ${term}`,
      ]) {
        expect(ids(await index.search({ query: `${variants} garden missing`, limit: 8 }))).toEqual(["two"]);
      }
    });
  }

  test("Latin accent and identifier punctuation variants cannot double-count a term", async () => {
    await add("latin", "café");
    await add("identifier", "INV-0042");
    expect(await index.search({ query: "café cafe garden missing", limit: 8 })).toEqual([]);
    expect(await index.search({ query: "INV-0042 INV/0042 garden missing", limit: 8 })).toEqual([]);
  });

  for (const { term, variants, repeatedContent } of [
    { term: "µm", variants: "µm μm", repeatedContent: "µm" },
    { term: "s", variants: "ſ s", repeatedContent: "s" },
    { term: "σ", variants: "Σ σ ς", repeatedContent: "σ" },
    { term: "ＦＯＯ", variants: "ＦＯＯ foo", repeatedContent: "ＦＯＯ foo" },
  ]) {
    test(`case and compatibility variants ${variants} cannot satisfy the threshold alone`, async () => {
      await add("one", repeatedContent);
      await add("two", `${term} soil`);
      expect(ids(await index.search({ query: `${term} soil missing`, limit: 8 }))).toEqual(["two"]);
      const hits = await index.search({ query: `${variants} soil missing`, limit: 8 });
      expect(ids(hits)).toEqual(["two"]);
      expect(hits[0]).toMatchObject({ lexicalMatchMode: "fallback" });
    });
  }

  test("distinct accented spellings retained by unicode61 remain distinct eligible terms", async () => {
    await add("greek", "λέξη");
    await add("vietnamese", "ộ");
    expect(await index.search({ query: "λέξη λεξη missing", limit: 8 })).toEqual([]);
    expect(await index.search({ query: "ộ o missing", limit: 8 })).toEqual([]);
  });

  test("stop words stay in exact queries; one eligible term and stop-word-only queries never broaden", async () => {
    await add("words", "the and");
    await add("garden", "garden");
    expect(await index.search({ query: "the and please", limit: 8 })).toEqual([]);
    expect(await index.search({ query: "please garden", limit: 8 })).toEqual([]);
    expect(await index.search({ query: "garden GARDEN please", limit: 8 })).toEqual([]);
    expect(await index.search({ query: '  ""  ', limit: 8 })).toEqual([]);
    expect((await index.search({ query: "the and", limit: 8 }))[0]).toMatchObject({ lexicalMatchMode: "exact" });
  });

  test("quoted identifiers remain whole phrases even in fallback", async () => {
    await add("correct", "invoice INV-0042 payment");
    await add("different", "invoice INV-0043 payment");
    await add("split", "INV unexpected 0042");
    expect(ids(await index.search({ query: "INV-0042", limit: 8 }))).toEqual(["correct"]);
    expect(ids(await index.search({ query: "INV-0042 nonexistent", limit: 8 }))).toEqual(["correct"]);
  });

  test("exact hits precede stronger fallback scores, deduplicate and break ties by chunk id", async () => {
    await add("exact", `garden bed missing ${"filler ".repeat(100)}`);
    await add("b", "garden bed", "garden bed");
    await add("a", "garden bed", "garden bed");
    await add("noise-1", "missing");
    await add("noise-2", "missing");
    const hits = await index.search({ query: "garden bed missing", limit: 3 });
    expect(ids(hits)).toEqual(["exact", "a", "b"]);
    expect(hits[1]!.lexicalScore).toBeGreaterThan(hits[0]!.lexicalScore);
    expect(hits.map((hit) => hit.lexicalRank)).toEqual([1, 2, 3]);
    expect(hits.map((hit) => (hit as { lexicalMatchMode?: string }).lexicalMatchMode)).toEqual(["exact", "fallback", "fallback"]);
    expect(ids(await index.search({ query: "garden bed missing", limit: 2 }))).toEqual(["exact", "a"]);
  });

  test("both passes apply document, collection, metadata and deletion filters before LIMIT", async () => {
    for (const id of ["allowed", "wrong-doc", "wrong-collection", "wrong-metadata", "deleted"]) {
      await add(id, "garden bed", id === "allowed" ? "" : "garden bed");
    }
    await client.execute("INSERT INTO collections(id, name, created_at, updated_at) VALUES ('garden', 'Garden', 0, 0)");
    await client.execute("UPDATE document_chunks SET collection_id = 'garden'");
    await client.execute("UPDATE document_chunks SET collection_id = NULL WHERE document_id = 'wrong-collection'");
    await client.execute("UPDATE documents SET metadata = '{\"type\":\"guide\"}'");
    await client.execute("UPDATE documents SET metadata = '{\"type\":\"other\"}' WHERE id = 'wrong-metadata'");
    await client.execute("UPDATE documents SET deleted_at = 1 WHERE id = 'deleted'");
    for (const query of ["garden bed", "garden bed missing"]) {
      const hits = await index.search({ query, limit: 1,
        documentIds: ["allowed", "wrong-collection", "wrong-metadata", "deleted"],
        collectionIds: ["garden"], filters: [{ field: "type", op: "eq", value: "guide" }] });
      expect(ids(hits)).toEqual(["allowed"]);
    }
  });

  test("optional fallback failures are logged and keep successful exact hits", async () => {
    await add("exact", "garden bed missing");
    const sqlClient = (index as unknown as { client: Client }).client;
    const execute = sqlClient.execute.bind(sqlClient);
    let calls = 0;
    const querySpy = spyOn(sqlClient, "execute").mockImplementation(async (statement) => {
      if (++calls === 2) throw new Error("injected optional fallback failure");
      return execute(statement);
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(ids(await index.search({ query: "garden bed missing", limit: 2 }))).toEqual(["exact"]);
      expect(calls).toBe(2);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally { querySpy.mockRestore(); warning.mockRestore(); }
  });

  test("a full exact pool never executes the optional fallback", async () => {
    await add("exact", "garden bed");
    const sqlClient = (index as unknown as { client: Client }).client;
    const execute = sqlClient.execute.bind(sqlClient);
    let calls = 0;
    const querySpy = spyOn(sqlClient, "execute").mockImplementation(async (statement) => {
      if (++calls > 1) throw new Error("unexpected fallback");
      return execute(statement);
    });
    try {
      expect(ids(await index.search({ query: "garden bed", limit: 1 }))).toEqual(["exact"]);
      expect(calls).toBe(1);
    } finally { querySpy.mockRestore(); }
  });

  test("hybrid search retains successful vector hits when fallback fails with no exact hits", async () => {
    const sqlClient = (index as unknown as { client: Client }).client;
    const execute = sqlClient.execute.bind(sqlClient);
    let calls = 0;
    const querySpy = spyOn(sqlClient, "execute").mockImplementation(async (statement) => {
      if (++calls === 2) throw new Error("injected optional fallback failure");
      return execute(statement);
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const service = new SearchService(
      { name: "fixture", model: "fixture", version: "1", dimensions: 1, embed: async () => [[1]] },
      { insert: async () => {}, deleteRevision: async () => {}, search: async () => [{
        chunkId: "vector-chunk", documentId: "vector-doc", revisionId: "vector-rev", content: "garden",
        headingPath: [], score: 1, vectorRank: 1, vectorScore: 1,
      }] }, index, repo, { VECTOR_CANDIDATES: 2, LEXICAL_CANDIDATES: 2, RRF_K: 60 },
    );
    try {
      const result = await service.search({ query: "garden bed", mode: "hybrid", limit: 2 });
      expect(result.hits.map((hit) => hit.documentId)).toEqual(["vector-doc"]);
      expect(calls).toBe(2);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally { querySpy.mockRestore(); warning.mockRestore(); }
  });

  test("exact query failures remain real failures", async () => {
    await client.execute("DROP TABLE document_chunks_fts");
    await expect(index.search({ query: "garden bed", limit: 8 })).rejects.toThrow();
  });

  test("title updates and chunk updates, replacements and deletes keep the index current", async () => {
    await add("guide", "original", "oldtitle");
    await repo.setDocumentStatus("guide", "ready", null, "newtitle");
    expect(await index.search({ query: "oldtitle", limit: 8 })).toEqual([]);
    expect(ids(await index.search({ query: "newtitle", limit: 8 }))).toEqual(["guide"]);
    await client.execute("UPDATE document_chunks SET content = 'newcontent', heading_path = '[\"newheading\"]'");
    expect(ids(await index.search({ query: "newtitle newheading newcontent", limit: 8 }))).toEqual(["guide"]);
    expect(await index.search({ query: "original", limit: 8 })).toEqual([]);
    await repo.replaceChunks("rev-guide", []);
    expect(await index.search({ query: "newtitle", limit: 8 })).toEqual([]);
  });
});
