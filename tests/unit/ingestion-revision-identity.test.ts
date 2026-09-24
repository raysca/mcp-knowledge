import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestionService } from "../../packages/core/src/index.ts";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";
import { NativeTextParser, createParserRegistry } from "../../packages/parser/src/index.ts";
import { LocalBlobStore } from "../../packages/storage/src/index.ts";
import { LibsqlVectorIndex } from "../../packages/retrieval/src/index.ts";

test("identical-content replacements have distinct chunks while retries within a revision stay stable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-revision-chunks-"));
  const url = `file:${join(dir, "app.db")}`;
  try {
    await migrateLibsql(url);
    const repo = createKnowledgeRepository(url);
    const blobs = new LocalBlobStore(join(dir, "blobs"));
    const bytes = new Blob(["# Guide\n\nIdentical content for both document revisions.\n"]);
    const ingestion = new IngestionService(repo, blobs, createParserRegistry([new NativeTextParser()]),
      (text) => text.split(/\s+/).length,
      { name: "test", model: "test", version: "1", dimensions: 384,
        embed: async (texts) => texts.map(() => Array.from({ length: 384 }, () => 0.1)) },
      new LibsqlVectorIndex(url),
      { MAX_EXTRACT_BYTES: 10000, MAX_SPREADSHEET_CELLS: 100, MAX_CHUNKS_PER_DOCUMENT: 100, EMBEDDING_BATCH_SIZE: 32 });
    const create = async (id: string, old?: string) => {
      await blobs.put(id, bytes);
      return repo.commitSourceImport({ mode: "import", sourceId: "source", relativePath: "guides/same.md",
        scanCycle: id, sha256: "same-hash", replaceDocumentId: old,
        prepared: { documentId: id, revisionId: `rev_${id}`, originalFilename: "same.md", mimeType: "text/markdown",
          extension: "md", sizeBytes: bytes.size, sha256: "same-hash", metadata: { sourcePath: "guides/same.md" }, storageKey: id } });
    };
    await create("old");
    const oldJob = (await repo.listJobs()).find((job) => job.documentId === "old")!;
    await ingestion.process(oldJob);
    const oldChunks = (await repo.listChunks("old", { limit: 100 })).items;
    expect(oldChunks).toHaveLength(1);
    await ingestion.process(oldJob);
    expect((await repo.listChunks("old", { limit: 100 })).items.map((chunk) => chunk.id)).toEqual(oldChunks.map((chunk) => chunk.id));

    await create("new", "old");
    const newJob = (await repo.listJobs()).find((job) => job.documentId === "new")!;
    await ingestion.process(newJob);
    const newChunks = (await repo.listChunks("new", { limit: 100 })).items;
    expect(newChunks).toHaveLength(1);
    expect(newChunks[0]!.id).not.toBe(oldChunks[0]!.id);
    expect(newChunks[0]!.content).toBe(oldChunks[0]!.content);
    expect(newChunks[0]!.contentHash).toBe(oldChunks[0]!.contentHash);
    await ingestion.process(newJob);
    expect((await repo.listChunks("new", { limit: 100 })).items.map((chunk) => chunk.id)).toEqual(newChunks.map((chunk) => chunk.id));
    expect((await repo.getDocument("new"))?.status).toBe("ready");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
