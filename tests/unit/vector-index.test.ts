import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
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

  test("search actually uses the vector index, not a full table scan", async () => {
    // Regression: the original query was `ORDER BY vector_distance_cos(...) LIMIT` directly
    // over document_chunks - verified with EXPLAIN QUERY PLAN that this ignores
    // document_chunks_embedding_idx entirely ("SCAN document_chunks"). libsql only consults a
    // vector index through the vector_top_k() virtual table.
    const client = createClient({ url });
    const plan = await client.execute({
      sql: `EXPLAIN QUERY PLAN SELECT c.id, vector_distance_cos(c.embedding, vector32(?)) AS dist
        FROM vector_top_k(?, vector32(?), ?) vt
        JOIN document_chunks c ON c.rowid = vt.id
        JOIN documents d ON d.id = c.document_id
        WHERE d.deleted_at IS NULL
        ORDER BY dist ASC LIMIT ?`,
      args: [
        JSON.stringify(unit(0)),
        "document_chunks_embedding_idx",
        JSON.stringify(unit(0)),
        20,
        8,
      ],
    });
    const details = plan.rows.map((r) => String(r.detail));
    expect(details.some((d) => d.includes("VIRTUAL TABLE"))).toBe(true);
    expect(details.some((d) => d.includes("SCAN document_chunks"))).toBe(false);
  });

  test("a mixed batch cannot repopulate deleted parents but still inserts and updates live embeddings", async () => {
    const repo = createKnowledgeRepository(url);
    const index = new LibsqlVectorIndex(url);
    const client = createClient({ url });
    try {
      for (const id of ["retired", "live"]) {
        await repo.createDocument({ documentId: id, revisionId: `rev_${id}`, originalFilename: `${id}.md`,
          mimeType: "text/markdown", sizeBytes: 1, sha256: id, metadata: {}, storageKey: id });
        await repo.replaceChunks(`rev_${id}`, [chunk({ id: `chk_${id}`, documentId: id, revisionId: `rev_${id}`,
          sequence: 0, content: id })]);
      }
      await index.insert([{ chunkId: "chk_retired", vector: unit(0) }]);
      await repo.softDeleteDocument("retired");
      await index.deleteRevision("rev_retired");
      await index.insert([{ chunkId: "chk_retired", vector: unit(0) }, { chunkId: "chk_live", vector: unit(1) }]);
      const rows = await client.execute("SELECT id, CASE WHEN embedding IS NOT NULL THEN vector_extract(embedding) END AS vector FROM document_chunks WHERE id IN ('chk_retired', 'chk_live') ORDER BY id");
      expect(rows.rows.map((row) => ({ id: row.id, vector: row.vector }))).toEqual([
        { id: "chk_live", vector: JSON.stringify(unit(1)) }, { id: "chk_retired", vector: null },
      ]);
      await index.insert([{ chunkId: "chk_live", vector: unit(0) }]);
      const live = await index.search({ vector: unit(0), documentIds: ["live"], limit: 1 });
      expect(live[0]?.chunkId).toBe("chk_live");
      expect(live[0]?.score).toBeCloseTo(1);
    } finally { client.close(); }
  });
});
