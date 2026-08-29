import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";
import { LibsqlVectorIndex } from "../../packages/retrieval/src/vector/libsql.ts";
import type { StoredChunk } from "../../packages/core/src/domain/types.ts";

function unit(i: number): number[] {
  const v = Array.from({ length: 384 }, () => 0);
  v[i] = 1;
  return v;
}

function chunk(partial: Pick<StoredChunk, "id" | "documentId" | "revisionId" | "sequence" | "content">): StoredChunk {
  return {
    ...partial,
    embeddingText: partial.content,
    headingPath: [],
    tokenCount: 1,
    metadata: {},
    contentHash: partial.id,
    createdAt: new Date(),
  };
}

describe("LibsqlVectorIndex", () => {
  let dir = "";
  let url = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-vec-"));
    url = `file:${join(dir, "app.db")}`;
    await migrateLibsql(url);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("cosine search ranks the nearer vector first and honors documentIds", async () => {
    const repo = createKnowledgeRepository(url);
    await repo.createDocument({
      documentId: "doc_a",
      revisionId: "rev_a",
      originalFilename: "a.md",
      mimeType: "text/markdown",
      sizeBytes: 1,
      sha256: "aa",
      metadata: {},
      storageKey: "a",
    });
    await repo.createDocument({
      documentId: "doc_b",
      revisionId: "rev_b",
      originalFilename: "b.md",
      mimeType: "text/markdown",
      sizeBytes: 1,
      sha256: "bb",
      metadata: {},
      storageKey: "b",
    });
    await repo.replaceChunks("rev_a", [
      chunk({ id: "chk_a", documentId: "doc_a", revisionId: "rev_a", sequence: 0, content: "topic A" }),
    ]);
    await repo.replaceChunks("rev_b", [
      chunk({ id: "chk_b", documentId: "doc_b", revisionId: "rev_b", sequence: 0, content: "topic B" }),
    ]);

    const index = new LibsqlVectorIndex(url);
    await index.insert([
      { chunkId: "chk_a", vector: unit(0) },
      { chunkId: "chk_b", vector: unit(1) },
    ]);

    const hits = await index.search({ vector: unit(0), limit: 8 });
    expect(hits[0]?.chunkId).toBe("chk_a");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? -1);
    expect(hits[0]?.vectorRank).toBe(1);

    const filtered = await index.search({ vector: unit(0), documentIds: ["doc_b"], limit: 8 });
    expect(filtered.map((h) => h.chunkId)).toEqual(["chk_b"]);

    await index.deleteRevision("rev_a");
    const after = await index.search({ vector: unit(0), limit: 8 });
    expect(after.every((h) => h.chunkId !== "chk_a")).toBe(true);
  });
});
