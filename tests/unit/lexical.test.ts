import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";
import { LibsqlLexicalIndex } from "../../packages/retrieval/src/lexical/libsql-fts.ts";
import type { StoredChunk } from "../../packages/core/src/domain/types.ts";

function chunk(partial: Pick<StoredChunk, "id" | "documentId" | "revisionId" | "sequence" | "content">): StoredChunk {
  return {
    ...partial,
    embeddingText: partial.content,
    headingPath: ["Invoices"],
    tokenCount: 1,
    metadata: {},
    contentHash: partial.id,
    createdAt: new Date(),
  };
}

describe("LibsqlLexicalIndex", () => {
  let dir = "";
  let url = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-fts-"));
    url = `file:${join(dir, "app.db")}`;
    await migrateLibsql(url);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("INV-0042 is findable (unicode61, no Porter stemmer)", async () => {
    const repo = createKnowledgeRepository(url);
    await repo.createDocument({
      documentId: "doc_sku",
      revisionId: "rev_sku",
      originalFilename: "inv.md",
      mimeType: "text/markdown",
      sizeBytes: 1,
      sha256: "sku",
      metadata: {},
      storageKey: "sku",
    });
    await repo.createDocument({
      documentId: "doc_other",
      revisionId: "rev_other",
      originalFilename: "other.md",
      mimeType: "text/markdown",
      sizeBytes: 1,
      sha256: "other",
      metadata: {},
      storageKey: "other",
    });
    await repo.replaceChunks("rev_sku", [
      chunk({
        id: "chk_sku",
        documentId: "doc_sku",
        revisionId: "rev_sku",
        sequence: 0,
        content: "Pay invoice INV-0042 within thirty days.",
      }),
    ]);
    await repo.replaceChunks("rev_other", [
      chunk({
        id: "chk_other",
        documentId: "doc_other",
        revisionId: "rev_other",
        sequence: 0,
        content: "Invoicing policy for all customers.",
      }),
    ]);

    const fts = new LibsqlLexicalIndex(url);
    const hits = await fts.search({ query: "INV-0042", limit: 8 });
    expect(hits[0]?.chunkId).toBe("chk_sku");
  });
});
