import { expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFilters } from "../../packages/core/src/index.ts";
import type { ListDocumentCatalogQuery } from "../../packages/core/src/ports.ts";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";

async function withRepository(run: (repo: ReturnType<typeof createKnowledgeRepository>, client: Client) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-catalog-"));
  const url = `file:${join(dir, "app.db")}`;
  const client = createClient({ url });
  try {
    await migrateLibsql(url);
    await run(createKnowledgeRepository(url), client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function create(repo: ReturnType<typeof createKnowledgeRepository>, id: string, metadata: Record<string, unknown> = {}, collectionId?: string) {
  await repo.createDocument({ documentId: id, revisionId: `rev_${id}`, originalFilename: `${id}.md`,
    mimeType: "text/markdown", sizeBytes: 1, sha256: id, metadata, storageKey: `secret/${id}`, collectionId });
}

test("generation advances on live creation and every catalog-relevant transition", async () => {
  await withRepository(async (repo, client) => {
    const initial = await repo.getCorpusGeneration();
    await create(repo, "doc");
    let previous = await repo.getCorpusGeneration();
    expect(previous).toBeGreaterThan(initial);
    const collection = await repo.createCollection({ name: "Guides" });
    const updates = [
      "status = 'processing'", "status = 'ready'", "title = 'New title'",
      "current_revision_id = 'rev_2'", "metadata = '{\"documentType\":\"guide\"}'",
      `collection_id = '${collection.id}'`, "original_filename = 'new.md'", "updated_at = updated_at + 1",
      "status = 'failed'", "status = 'ready'", "status = 'deleted'", "status = 'ready'",
      "deleted_at = 123", "deleted_at = NULL",
    ];
    for (const update of updates) {
      await client.execute(`UPDATE documents SET ${update} WHERE id = 'doc'`);
      const generation = await repo.getCorpusGeneration();
      expect(generation).toBeGreaterThan(previous);
      previous = generation;
    }
    await repo.softDeleteDocument("doc");
    expect(await repo.getCorpusGeneration()).toBeGreaterThan(previous);
    await create(repo, "hard");
    previous = await repo.getCorpusGeneration();
    await client.execute("DELETE FROM documents WHERE id = 'hard'");
    expect(await repo.getCorpusGeneration()).toBeGreaterThan(previous);
  });
});

test("generation and catalog changes roll back with document transactions", async () => {
  await withRepository(async (repo, client) => {
    await create(repo, "doc");
    await repo.setDocumentStatus("doc", "ready", null, "Before");
    const generation = await repo.getCorpusGeneration();
    const tx = await client.transaction("write");
    try {
      await tx.execute("UPDATE documents SET title = 'Rolled back' WHERE id = 'doc'");
      expect(Number((await tx.execute("SELECT generation FROM corpus_state")).rows[0]?.generation)).toBeGreaterThan(generation);
      await tx.rollback();
    } finally { tx.close(); }
    expect(await repo.getCorpusGeneration()).toBe(generation);
    expect((await repo.listDocumentCatalog({ limit: 10 })).items[0]?.title).toBe("Before");
  });
});

test("catalog defaults to live ready rows and exposes only the requested safe fields", async () => {
  await withRepository(async (repo) => {
    await create(repo, "ready", { sourcePath: "articles/guide.md", nested: { keep: true } });
    await create(repo, "pending");
    await create(repo, "failed");
    await create(repo, "deleted");
    await repo.setDocumentStatus("ready", "ready", null, "Guide");
    await repo.setDocumentStatus("failed", "failed");
    await repo.setDocumentStatus("deleted", "ready");
    await repo.softDeleteDocument("deleted");
    expect((await repo.listDocumentCatalog({ limit: 10 })).items).toEqual([{
      id: "ready", revisionId: "rev_ready", title: "Guide", sourcePath: "articles/guide.md",
      metadata: { sourcePath: "articles/guide.md", nested: { keep: true } },
    }]);
    expect((await repo.listDocumentCatalog({ limit: 10, status: "failed", fields: ["id", "sourcePath", "status"] })).items)
      .toEqual([{ id: "failed", sourcePath: "failed.md", status: "failed" }]);
    const projected = (await repo.listDocumentCatalog({ limit: 10, fields: ["updatedAt"] })).items[0];
    expect(Object.keys(projected!)).toEqual(["updatedAt"]);
    expect(projected?.updatedAt).toBeInstanceOf(Date);
  });
});

test("catalog applies collection and shared metadata filters before pagination", async () => {
  await withRepository(async (repo, client) => {
    const a = await repo.createCollection({ name: "A" });
    const b = await repo.createCollection({ name: "B" });
    for (const [id, collection, metadata] of [
      ["z", a.id, { documentType: "other", year: 2026 }],
      ["y", b.id, { documentType: "guide", year: 2026 }],
      ["b", a.id, { documentType: "guide", year: 2026, nested: { active: true } }],
      ["a", a.id, { documentType: "guide", year: 2025, nested: { active: true } }],
    ] as const) {
      await create(repo, id, metadata, collection);
      await repo.setDocumentStatus(id, "ready");
    }
    await client.execute("UPDATE documents SET created_at = 1000");
    const query = { limit: 1, collectionId: a.id, fields: ["id"] as const,
      filters: parseFilters({ documentType: { in: ["guide"] }, year: { gte: 2025, lte: 2026 },
        "nested.active": true, missing: { exists: false }, ignored: { neq: "no" } }) };
    const first = await repo.listDocumentCatalog({ ...query, fields: [...query.fields] });
    expect(first.items).toEqual([{ id: "b" }]);
    expect(first.nextCursor).toBeString();
    const last = await repo.listDocumentCatalog({ ...query, fields: [...query.fields], cursor: first.nextCursor });
    expect(last.items).toEqual([{ id: "a" }]);
    expect(last.nextCursor).toBeUndefined();
  });
});

test("catalog keyset pages duplicate timestamps and can seek after a deleted anchor", async () => {
  await withRepository(async (repo, client) => {
    for (const id of ["a", "b", "c", "d"]) { await create(repo, id); await repo.setDocumentStatus(id, "ready"); }
    await client.execute("UPDATE documents SET created_at = 1000");
    await client.execute("UPDATE documents SET created_at = 2000 WHERE id = 'a'");
    const first = await repo.listDocumentCatalog({ limit: 2, fields: ["id"] });
    expect(first.items).toEqual([{ id: "a" }, { id: "d" }]);
    await repo.softDeleteDocument("d");
    const second = await repo.listDocumentCatalog({ limit: 2, fields: ["id"], cursor: first.nextCursor });
    expect(second.items).toEqual([{ id: "c" }, { id: "b" }]);
    expect(second.nextCursor).toBeUndefined();
  });
});

test("catalog rejects malformed cursors and unchecked fields before executing SQL", async () => {
  await withRepository(async (repo) => {
    for (const cursor of ["", "!", "YWJj", Buffer.from("NaN:doc").toString("base64url"), Buffer.from("100:").toString("base64url"), Buffer.from("-1:doc").toString("base64url")]) {
      await expect(repo.listDocumentCatalog({ limit: 10, cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR", status: 400 });
    }
    for (const fields of [["sha256"], ["storageKey"], ["id; DROP TABLE documents"], []]) {
      await expect(repo.listDocumentCatalog({ limit: 10, fields } as ListDocumentCatalogQuery)).rejects.toMatchObject({ code: "INVALID_PROJECTION", status: 400 });
    }
    await expect(repo.listDocumentCatalog({ limit: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT", status: 400 });
    await expect(repo.listDocumentCatalog({ limit: 1, filters: [{ field: "bad') OR 1=1 --", op: "eq", value: "x" }] }))
      .rejects.toMatchObject({ code: "INVALID_FILTER", status: 400 });
  });
});

test("catalog rejects non-finite parsed filter clauses before driver binding", async () => {
  await withRepository(async (repo) => {
    await create(repo, "finite", { year: 2026, rating: 4.5 });
    await repo.setDocumentStatus("finite", "ready");
    for (const op of ["eq", "neq", "in", "gte", "lte"] as const) {
      for (const number of [NaN, Infinity, -Infinity, JSON.parse("1e999")]) {
        await expect(repo.listDocumentCatalog({ limit: 10,
          filters: [{ field: "year", op, value: op === "in" ? [2026, number] : number }],
        })).rejects.toMatchObject({ code: "INVALID_FILTER", status: 400 });
      }
    }
    expect((await repo.listDocumentCatalog({ limit: 10, fields: ["id"],
      filters: parseFilters({ year: { eq: 2026, neq: 0, in: [2025, 2026] }, rating: { gte: 4.25, lte: 4.75 } }),
    })).items).toEqual([{ id: "finite" }]);
  });
});

test("catalog migration upgrades existing rows, rolls back a failure, and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-catalog-migration-"));
  const url = `file:${join(dir, "app.db")}`;
  const client = createClient({ url });
  try {
    await client.executeMultiple(await Bun.file(new URL("../../drizzle/0001_init.sql", import.meta.url)).text());
    await client.execute(`INSERT INTO documents(id, original_filename, mime_type, size_bytes, sha256, status, created_at, updated_at)
      VALUES ('legacy', 'legacy.md', 'text/markdown', 1, 'legacy', 'ready', 0, 0)`);
    await client.executeMultiple(await Bun.file(new URL("../../drizzle/0002_embeddings.sql", import.meta.url)).text());
    const repo = createKnowledgeRepository(url);
    await create(repo, "retired");
    await repo.replaceChunks("rev_retired", [{ id: "chk_retired", documentId: "retired", revisionId: "rev_retired",
      sequence: 0, content: "retained history", embeddingText: "retained history", headingPath: [],
      tokenCount: 2, metadata: {}, contentHash: "history", createdAt: new Date() }]);
    const legacyVector = JSON.stringify(Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0));
    await client.execute({ sql: "UPDATE document_chunks SET embedding = vector32(?) WHERE id = 'chk_retired'", args: [legacyVector] });
    await repo.softDeleteDocument("retired");
    // Conflicting schema makes index creation fail after the state table was created.
    await client.execute("CREATE TABLE documents_catalog_order (id INTEGER)");
    await expect(migrateLibsql(url)).rejects.toThrow();
    expect((await client.execute("SELECT name FROM sqlite_master WHERE name = 'corpus_state'")).rows).toHaveLength(0);
    expect((await client.execute("SELECT vector_extract(embedding) AS vector FROM document_chunks WHERE id = 'chk_retired'")).rows[0]!.vector).toBe(legacyVector);
    await client.execute("DROP TABLE documents_catalog_order");
    await migrateLibsql(url);
    expect(Number((await client.execute("SELECT embedding IS NULL AS cleared FROM document_chunks WHERE id = 'chk_retired'")).rows[0]!.cleared)).toBe(1);
    expect((await client.execute("SELECT content FROM document_chunks WHERE id = 'chk_retired'")).rows[0]!.content).toBe("retained history");
    const generation = await repo.getCorpusGeneration();
    expect((await repo.listDocumentCatalog({ limit: 10, fields: ["id"] })).items).toEqual([{ id: "legacy" }]);
    await migrateLibsql(url);
    expect(await repo.getCorpusGeneration()).toBe(generation);
    await client.execute("UPDATE documents SET status = 'failed' WHERE id = 'legacy'");
    expect(await repo.getCorpusGeneration()).toBeGreaterThan(generation);
    const changed = await repo.getCorpusGeneration();
    await migrateLibsql(url);
    expect(await repo.getCorpusGeneration()).toBe(changed);
  } finally { client.close(); await rm(dir, { recursive: true, force: true }); }
});
