import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileFilters, parseFilters } from "../../packages/core/src/retrieval/filters.ts";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";
import { LibsqlVectorIndex } from "../../packages/retrieval/src/vector/libsql.ts";
import { LibsqlLexicalIndex } from "../../packages/retrieval/src/lexical/libsql-fts.ts";
import type { StoredChunk } from "../../packages/core/src/domain/types.ts";

describe("filters", () => {
  test("parses eq shorthand and operators", () => {
    expect(parseFilters({ department: "legal" })).toEqual([
      { field: "department", op: "eq", value: "legal" },
    ]);
    expect(parseFilters({ year: { gte: 2020, lte: 2024 } })).toEqual([
      { field: "year", op: "gte", value: 2020 },
      { field: "year", op: "lte", value: 2024 },
    ]);
  });

  test("compiles eq to json_extract on chunk or document metadata", () => {
    const { sql, args } = compileFilters([{ field: "department", op: "eq", value: "legal" }]);
    expect(sql).toContain("json_extract(c.metadata");
    expect(sql).toContain("json_extract(d.metadata");
    expect(args).toEqual(["$.department", "legal", "$.department", "legal"]);
  });

  test("rejects unsafe field names", () => {
    expect(() => parseFilters({ "dept) OR 1=1": "x" })).toThrow(/Invalid filter field/);
  });

  test("rejects empty dotted path segments and retains valid nested fields", () => {
    for (const field of [".", ".department", "department.", "department..category"]) {
      let error: unknown;
      try {
        parseFilters({ [field]: "garden" });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "INVALID_FILTER", status: 400 });
    }
    expect(parseFilters({ "department.category": "garden" })).toEqual([
      { field: "department.category", op: "eq", value: "garden" },
    ]);
  });

  test("rejects non-scalar filter values instead of crashing the driver", () => {
    // Regression: filter values are bound straight to the SQLite driver (where.ts), which
    // only accepts numbers/strings/bigints/buffers/null. An array or object slipping through
    // (a plausible client typo, e.g. gte: [2020] instead of gte: 2020) threw an uncaught
    // driver error -> 500, instead of a clean 400 at the API boundary.
    expect(() => parseFilters({ year: { gte: [2020] } })).toThrow(/INVALID_FILTER|must be a number/);
    expect(() => parseFilters({ tags: { in: "not-an-array" } })).toThrow(/INVALID_FILTER|must be a/);
    expect(() => parseFilters({ tags: { in: [] } })).toThrow(/INVALID_FILTER|must be a/);
    expect(() => parseFilters({ department: { eq: { nested: true } } })).toThrow(/INVALID_FILTER|scalar/);
    expect(() => parseFilters({ department: [1, 2] })).toThrow(/INVALID_FILTER|scalar/);
    // valid shapes still pass
    expect(() => parseFilters({ year: { gte: 2020 } })).not.toThrow();
    expect(() => parseFilters({ tags: { in: ["a", "b"] } })).not.toThrow();
  });

  for (const op of ["eq", "neq", "in", "gte", "lte"] as const) {
    test(`rejects non-finite numeric ${op} values with INVALID_FILTER`, () => {
      for (const number of [NaN, Infinity, -Infinity]) {
        let error: unknown;
        try { parseFilters({ year: { [op]: op === "in" ? [2026, number] : number } }); }
        catch (caught) { error = caught; }
        expect(error).toMatchObject({ code: "INVALID_FILTER", status: 400 });
      }
    });

    test(`rejects overflowing JSON numbers in ${op} with INVALID_FILTER`, () => {
      for (const literal of ["1e999", "-1e999"]) {
        const raw = JSON.parse(`{"year":{"${op}":${op === "in" ? `[2026,${literal}]` : literal}}}`);
        let error: unknown;
        try { parseFilters(raw); }
        catch (caught) { error = caught; }
        expect(error).toMatchObject({ code: "INVALID_FILTER", status: 400 });
      }
    });
  }

  test("preserves finite numbers and existing scalar types across filter operators", () => {
    for (const value of [0, -42, 4.5, Number.MAX_VALUE, "guide", true, false, null]) {
      expect(parseFilters({ value })).toEqual([{ field: "value", op: "eq", value }]);
      expect(parseFilters({ value: { eq: value, neq: value, in: [value] } })).toEqual([
        { field: "value", op: "eq", value },
        { field: "value", op: "neq", value },
        { field: "value", op: "in", value: [value] },
      ]);
      if (typeof value === "number") {
        expect(parseFilters({ value: { gte: value, lte: value } })).toEqual([
          { field: "value", op: "gte", value }, { field: "value", op: "lte", value },
        ]);
      }
    }
  });

  test("rejects non-finite shorthand equality values with INVALID_FILTER", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      let error: unknown;
      try { parseFilters({ value }); }
      catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: "INVALID_FILTER", status: 400 });
    }
  });
});

function unit(i: number, last = 0): number[] {
  const v = Array.from({ length: 384 }, () => 0);
  v[i] = 1;
  v[383] = last;
  return v;
}

for (const mode of ["lexical", "vector"] as const) {
  test(`${mode} null filters match explicit null in chunk or document metadata and preserve existence semantics`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-null-filter-"));
    const url = `file:${join(dir, "app.db")}`;
    try {
      await migrateLibsql(url);
      const repo = createKnowledgeRepository(url);
      const vectors = new LibsqlVectorIndex(url);
      const lexical = new LibsqlLexicalIndex(url);
      const rows: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
        ["missing", {}, {}], ["doc_null", { review: { state: null } }, {}],
        ["chunk_null", {}, { review: { state: null } }],
        ["doc_yes", { review: { state: "yes" } }, {}], ["chunk_yes", {}, { review: { state: "yes" } }],
        ["doc_null_chunk_no", { review: { state: null } }, { review: { state: "no" } }],
        ["doc_no_chunk_null", { review: { state: "no" } }, { review: { state: null } }],
        ["text_null", { review: { state: "null" } }, {}],
        ["quoted", {}, { review: { state: "yes') OR 1=1 --" } }],
        ["excluded_null", { allowed: "no", review: { state: null } }, {}],
      ];
      for (const [id, documentMetadata, chunkMetadata] of rows) {
        await repo.createDocument({ documentId: id, revisionId: `rev_${id}`, originalFilename: `${id}.md`,
          mimeType: "text/markdown", sizeBytes: 1, sha256: id, storageKey: id,
          metadata: { allowed: "yes", ...documentMetadata } });
        await repo.replaceChunks(`rev_${id}`, [{ id: `chunk_${id}`, documentId: id, revisionId: `rev_${id}`,
          sequence: 0, content: "reviewable", embeddingText: "reviewable", headingPath: [], tokenCount: 1,
          metadata: chunkMetadata, contentHash: id, createdAt: new Date() }]);
        await vectors.insert([{ chunkId: `chunk_${id}`, vector: unit(0) }]);
      }
      const nullIds = ["chunk_null", "doc_no_chunk_null", "doc_null", "doc_null_chunk_no"];
      const cases: Array<[unknown, string[]]> = [
        [null, nullIds], [{ eq: null }, nullIds], [{ in: [null] }, nullIds],
        [{ in: [null, "yes"] }, ["chunk_null", "chunk_yes", "doc_no_chunk_null", "doc_null", "doc_null_chunk_no", "doc_yes"]],
        [{ in: ["yes", null, null] }, ["chunk_null", "chunk_yes", "doc_no_chunk_null", "doc_null", "doc_null_chunk_no", "doc_yes"]],
        [{ in: [null, "yes') OR 1=1 --"] }, [...nullIds, "quoted"]],
        [{ exists: false }, ["chunk_null", "doc_null", "missing"]],
        [{ exists: true }, ["chunk_yes", "doc_no_chunk_null", "doc_null_chunk_no", "doc_yes", "quoted", "text_null"]],
        [{ neq: null }, ["chunk_yes", "doc_no_chunk_null", "doc_null_chunk_no", "doc_yes", "quoted", "text_null"]],
      ];
      for (const [spec, ids] of cases) {
        const filters = parseFilters({ allowed: "yes", "review.state": spec });
        const hits = mode === "vector"
          ? await vectors.search({ vector: unit(0), filters, limit: 20 })
          : await lexical.search({ query: "reviewable", filters, limit: 20 });
        expect(hits.map((hit) => hit.documentId).sort()).toEqual(ids);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

function chunkOf(id: string, keep: boolean, seq: number): StoredChunk {
  return {
    id,
    documentId: "doc_pool",
    revisionId: "rev_pool",
    sequence: seq,
    content: `chunk ${seq}`,
    embeddingText: `chunk ${seq}`,
    headingPath: [],
    tokenCount: 1,
    metadata: keep ? { keep: "yes" } : {},
    contentHash: id,
    createdAt: new Date(),
  };
}

describe("filters inside candidate queries", () => {
  let dir = "";
  let url = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-filt-"));
    url = `file:${join(dir, "app.db")}`;
    await migrateLibsql(url);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("filtered results are not capped by an unfiltered top-50 pool", async () => {
    const repo = createKnowledgeRepository(url);
    await repo.createDocument({
      documentId: "doc_pool",
      revisionId: "rev_pool",
      originalFilename: "pool.md",
      mimeType: "text/markdown",
      sizeBytes: 1,
      sha256: "pool",
      metadata: { year: 2026, rating: 4.5 },
      storageKey: "pool",
    });
    const chunks: StoredChunk[] = [];
    const embedded: { chunkId: string; vector: number[] }[] = [];
    for (let i = 0; i < 9; i++) {
      const id = `chk_close_${i}`;
      chunks.push(chunkOf(id, false, i));
      embedded.push({ chunkId: id, vector: unit(0, 0) });
    }
    for (let i = 0; i < 51; i++) {
      const id = `chk_keep_${i}`;
      chunks.push(chunkOf(id, true, 9 + i));
      embedded.push({ chunkId: id, vector: unit(0, 0.05) });
    }
    await repo.replaceChunks("rev_pool", chunks);
    const index = new LibsqlVectorIndex(url);
    await index.insert(embedded);
    const hits = await index.search({
      vector: unit(0, 0),
      filters: parseFilters({ keep: "yes", year: { in: [2025, 2026] }, rating: { gte: 4.25, lte: 4.75 } }),
      limit: 50,
    });
    expect(hits.length).toBe(50);
    expect(hits.every((h) => h.chunkId.startsWith("chk_keep_"))).toBe(true);
  });
});
