import { expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLibsql } from "../../packages/db/src/index.ts";

test("title migration backfills an existing 0003 index, rolls back failures, and can be repeated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-title-migration-"));
  const url = `file:${join(dir, "app.db")}`;
  const client = createClient({ url });
  try {
    for (const migration of ["0001_init.sql", "0002_embeddings.sql", "0003_fts.sql"]) {
      await client.executeMultiple(await Bun.file(new URL(`../../drizzle/${migration}`, import.meta.url)).text());
    }
    await client.execute(`INSERT INTO documents(id, title, original_filename, mime_type, size_bytes, sha256, status, created_at, updated_at)
      VALUES ('doc', 'Backfilled title', 'guide.md', 'text/markdown', 1, 'doc', 'ready', 0, 0)`);
    await client.execute(`INSERT INTO document_revisions(id, document_id, revision, storage_key, sha256, size_bytes,
      parser_name, parser_version, chunker_name, chunker_version, embedding_model, embedding_dimensions, embedding_version, created_at)
      VALUES ('rev', 'doc', 1, 'key', 'doc', 1, 'p', '1', 'c', '1', 'e', 1, '1', 0)`);
    await client.execute(`INSERT INTO document_chunks(id, document_id, revision_id, sequence, content, embedding_text,
      heading_path, token_count, content_hash, created_at) VALUES ('chunk', 'doc', 'rev', 0, 'body', 'body', '["heading"]', 1, 'c', 0)`);

    // Simulate a corrupt legacy row: a failed backfill must not destroy the old searchable index.
    await client.execute("DROP TRIGGER document_chunks_fts_au");
    await client.execute("UPDATE document_chunks SET heading_path = 'invalid-json'");
    await expect(migrateLibsql(url)).rejects.toThrow();
    expect((await client.execute("PRAGMA table_info(document_chunks_fts)")).rows.map((row) => row.name))
      .toEqual(["chunk_id", "content", "heading_path"]);
    expect((await client.execute("SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH 'body'")).rows)
      .toHaveLength(1);
    await client.execute("UPDATE document_chunks SET heading_path = '[\"heading\"]'");

    await migrateLibsql(url);
    await migrateLibsql(url);
    expect((await client.execute("PRAGMA table_info(document_chunks_fts)")).rows.map((row) => row.name))
      .toEqual(["chunk_id", "title", "heading_path", "content"]);
    expect((await client.execute("SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH 'Backfilled'")).rows)
      .toHaveLength(1);
    // The migration SQL itself is repeatable too, inside its caller-owned transaction.
    const migration = await Bun.file(new URL("../../drizzle/0006_fts_titles.sql", import.meta.url)).text();
    for (let i = 0; i < 2; i++) {
      const tx = await client.transaction("write");
      try { await tx.executeMultiple(migration); await tx.commit(); }
      finally { tx.close(); }
    }
    expect((await client.execute("SELECT count(*) AS n FROM document_chunks_fts")).rows[0]?.n).toBe(1);
    await client.execute("UPDATE documents SET title = 'Fresh'");
    expect((await client.execute("SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH 'Fresh'")).rows)
      .toHaveLength(1);
    expect((await client.execute("SELECT chunk_id FROM document_chunks_fts WHERE document_chunks_fts MATCH 'Backfilled'")).rows)
      .toHaveLength(0);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
