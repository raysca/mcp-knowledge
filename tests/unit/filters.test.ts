import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileFilters, parseFilters } from "../../packages/core/src/retrieval/filters.ts";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";
import { LibsqlVectorIndex } from "../../packages/retrieval/src/vector/libsql.ts";
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
});

function unit(i: number, last = 0): number[] {
  const v = Array.from({ length: 384 }, () => 0);
  v[i] = 1;
  v[383] = last;
  return v;
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
      metadata: {},
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
      filters: [{ field: "keep", op: "eq", value: "yes" }],
      limit: 50,
    });
    expect(hits.length).toBe(50);
    expect(hits.every((h) => h.chunkId.startsWith("chk_keep_"))).toBe(true);
  });
});
