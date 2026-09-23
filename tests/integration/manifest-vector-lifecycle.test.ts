import { expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestionService, SourceImportService } from "../../packages/core/src/index.ts";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";
import { NativeTextParser, createParserRegistry } from "../../packages/parser/src/index.ts";
import { LocalBlobStore } from "../../packages/storage/src/index.ts";
import { LibsqlLexicalIndex, LibsqlVectorIndex } from "../../packages/retrieval/src/index.ts";
import { LocalDirectorySource } from "../../apps/server/src/startup-scan/local-directory-source.ts";

test("repeated manifest replacements keep the live document in ANN at limit one without deleting history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-manifest-ann-"));
  const url = `file:${join(dir, "app.db")}`;
  const client = createClient({ url });
  try {
    await migrateLibsql(url);
    const sourceRoot = join(dir, "source");
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, "guide.md"), "# Seed guide\n\nIdentical seeds need careful watering.\n");
    const repo = createKnowledgeRepository(url);
    const blobs = new LocalBlobStore(join(dir, "blobs"));
    const vectors = new LibsqlVectorIndex(url);
    const lexical = new LibsqlLexicalIndex(url);
    const vector = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
    const ingestion = new IngestionService(repo, blobs, createParserRegistry([new NativeTextParser()]),
      (text) => text.split(/\s+/).length,
      { name: "test", model: "test", version: "1", dimensions: 384, embed: async (texts) => texts.map(() => vector) },
      vectors, { MAX_EXTRACT_BYTES: 10000, MAX_SPREADSHEET_CELLS: 100, MAX_CHUNKS_PER_DOCUMENT: 100, EMBEDDING_BATCH_SIZE: 32 });
    let liveId = "";

    for (let version = 0; version < 12; version += 1) {
      await writeFile(join(sourceRoot, ".mcp-knowledge-manifest.json"), JSON.stringify({
        rules: [{ glob: "*.md", metadata: { version } }],
      }));
      const source = await LocalDirectorySource.create({ root: sourceRoot, maxDepth: 0 });
      const signal = new AbortController().signal;
      const candidates = await Array.fromAsync(source.candidates(signal));
      expect(candidates).toHaveLength(1);
      const importer = new SourceImportService({ source, repo, blobs, maxUploadBytes: 10000, signal,
        archives: { stage: async () => { throw new Error("No archives are present in this fixture."); } } });
      const imported = await importer.process(candidates[0]!, `cycle-${version}`);
      expect(imported.outcome).toBe("queued");
      if (liveId) expect(imported.replacedDocumentId).toBe(liveId);
      liveId = imported.documentId!;
      const job = (await repo.listJobs()).find((entry) => entry.documentId === liveId)!;
      await ingestion.process(job);
      expect((await repo.getDocument(liveId))?.metadata.version).toBe(version);
      expect((await vectors.search({ vector, limit: 1 })).map((hit) => hit.documentId)).toEqual([liveId]);
      expect((await lexical.search({ query: "seeds", limit: 1 })).map((hit) => hit.documentId)).toEqual([liveId]);
      const rows = await client.execute("SELECT document_id, embedding IS NULL AS cleared FROM document_chunks");
      expect(rows.rows).toHaveLength(version + 1);
      for (const row of rows.rows) {
        expect(Number(row.cleared)).toBe(row.document_id === liveId ? 0 : 1);
      }
    }

    // A retired worker may have produced vectors before replacement and resume here.
    const retired = await client.execute({ sql: "SELECT id FROM document_chunks WHERE document_id != ?", args: [liveId] });
    expect(retired.rows).toHaveLength(11);
    await vectors.insert(retired.rows.map((row) => ({ chunkId: String(row.id), vector })));
    const resurrected = await client.execute({
      sql: "SELECT COUNT(*) AS n FROM document_chunks WHERE document_id != ? AND embedding IS NOT NULL", args: [liveId],
    });
    expect(Number(resurrected.rows[0]!.n)).toBe(0);
    expect((await vectors.search({ vector, limit: 1 })).map((hit) => hit.documentId)).toEqual([liveId]);
    expect((await lexical.search({ query: "seeds", limit: 20 })).map((hit) => hit.documentId)).toEqual([liveId]);
    expect(Number((await client.execute("SELECT COUNT(*) AS n FROM document_revisions")).rows[0]!.n)).toBe(12);
    expect(Number((await client.execute("SELECT COUNT(*) AS n FROM document_chunks_fts")).rows[0]!.n)).toBe(12);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
