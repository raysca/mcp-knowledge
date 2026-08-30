import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";
import type { StoredChunk } from "../../packages/core/src/domain/types.ts";

function chunk(partial: Pick<StoredChunk, "id" | "documentId" | "revisionId" | "sequence" | "content">): StoredChunk {
  return {
    ...partial,
    embeddingText: partial.content,
    headingPath: ["A"],
    tokenCount: 4,
    metadata: {},
    contentHash: partial.id,
    createdAt: new Date(),
  };
}

describe("purgeDocuments", () => {
  let dir = "";
  let url = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-purge-repo-"));
    url = `file:${join(dir, "app.db")}`;
    await migrateLibsql(url);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("hard-deletes documents, chunks, FTS, and jobs; keeps collections and keys", async () => {
    const repo = createKnowledgeRepository(url);
    const col = await repo.createCollection({ name: "Keep" });
    await repo.createDocument({
      documentId: "doc_purge1",
      revisionId: "rev_purge1",
      collectionId: col.id,
      originalFilename: "a.md",
      mimeType: "text/markdown",
      extension: "md",
      sizeBytes: 3,
      sha256: "aa",
      metadata: {},
      storageKey: "documents/doc_purge1/revisions/rev_purge1/original",
    });
    await repo.enqueueJob({ documentId: "doc_purge1", revisionId: "rev_purge1" });
    await repo.replaceChunks("rev_purge1", [
      chunk({
        id: "chk_purge1",
        documentId: "doc_purge1",
        revisionId: "rev_purge1",
        sequence: 0,
        content: "INV-0042 stays searchable until purge",
      }),
    ]);
    const key = await repo.createApiKey({
      name: "keep",
      keyPrefix: "key_keepxxxx",
      keyHash: "00".repeat(32),
      scopes: ["admin"],
    });

    const keys = await repo.listRevisionBlobKeys();
    expect(keys).toContain("documents/doc_purge1/revisions/rev_purge1/original");

    const deleted = await repo.purgeDocuments();
    expect(deleted).toBe(1);
    expect((await repo.listDocuments({ limit: 50 })).items).toEqual([]);
    expect(await repo.listCollections()).toEqual([expect.objectContaining({ id: col.id })]);
    expect((await repo.listApiKeys()).map((k) => k.id)).toContain(key.id);

    const client = createClient({ url });
    const chunks = await client.execute("SELECT COUNT(*) AS n FROM document_chunks");
    const fts = await client.execute("SELECT COUNT(*) AS n FROM document_chunks_fts");
    const jobs = await client.execute("SELECT COUNT(*) AS n FROM ingestion_jobs");
    client.close();
    expect(Number(chunks.rows[0]!.n)).toBe(0);
    expect(Number(fts.rows[0]!.n)).toBe(0);
    expect(Number(jobs.rows[0]!.n)).toBe(0);
  });
});
