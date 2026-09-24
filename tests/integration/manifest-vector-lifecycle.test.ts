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

test("upgraded corpora and repeated manifest replacements keep live ANN hits at limit one without deleting history", async () => {
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
    const baselineVector = Array.from({ length: 384 }, (_, index) => index === 1 ? 1 : 0);
    // Recreate pre-fix persisted state: a deleted parent's vector is closer to
    // the query than the live baseline's, so failure does not depend on tie order.
    for (const id of ["legacy_deleted", "baseline_live"]) {
      await repo.createDocument({ documentId: id, revisionId: `rev_${id}`, originalFilename: `${id}.md`,
        mimeType: "text/markdown", sizeBytes: 1, sha256: id, metadata: { retained: true }, storageKey: id });
      await repo.replaceChunks(`rev_${id}`, [{ id: `chk_${id}`, documentId: id, revisionId: `rev_${id}`,
        sequence: 0, content: `historical ${id}`, embeddingText: `historical ${id}`, headingPath: [],
        tokenCount: 2, metadata: {}, contentHash: id, createdAt: new Date() }]);
      await vectors.insert([{ chunkId: `chk_${id}`, vector: id === "legacy_deleted" ? vector : baselineVector }]);
      await repo.setDocumentStatus(id, "ready");
    }
    await repo.softDeleteDocument("legacy_deleted");
    expect(await vectors.search({ vector, limit: 1 })).toEqual([]);
    const generation = await repo.getCorpusGeneration();
    const documentsBefore = await client.execute("SELECT * FROM documents ORDER BY id");
    const revisionsBefore = await client.execute("SELECT * FROM document_revisions ORDER BY id");
    const textBefore = await client.execute("SELECT id, content, metadata FROM document_chunks ORDER BY id");
    const ftsBefore = await client.execute("SELECT chunk_id, title, content, heading_path FROM document_chunks_fts ORDER BY chunk_id");
    await client.executeMultiple(`CREATE TABLE embedding_cleanup_audit (document_id TEXT);
      CREATE TRIGGER count_embedding_cleanup AFTER UPDATE OF embedding ON document_chunks
      BEGIN INSERT INTO embedding_cleanup_audit(document_id) VALUES (NEW.document_id); END;`);
    for (let run = 0; run < 2; run += 1) {
      await migrateLibsql(url);
      expect(await repo.getCorpusGeneration()).toBe(generation);
      expect(Number((await client.execute("SELECT embedding IS NULL AS cleared FROM document_chunks WHERE id = 'chk_legacy_deleted'")).rows[0]!.cleared)).toBe(1);
      expect((await client.execute("SELECT vector_extract(embedding) AS vector FROM document_chunks WHERE id = 'chk_baseline_live'")).rows[0]!.vector).toBe(JSON.stringify(baselineVector));
      expect((await client.execute("SELECT document_id FROM embedding_cleanup_audit")).rows.map((row) => row.document_id)).toEqual(["legacy_deleted"]);
      expect((await client.execute("SELECT * FROM documents ORDER BY id")).rows).toEqual(documentsBefore.rows);
      expect((await client.execute("SELECT * FROM document_revisions ORDER BY id")).rows).toEqual(revisionsBefore.rows);
      expect((await client.execute("SELECT id, content, metadata FROM document_chunks ORDER BY id")).rows).toEqual(textBefore.rows);
      expect((await client.execute("SELECT chunk_id, title, content, heading_path FROM document_chunks_fts ORDER BY chunk_id")).rows).toEqual(ftsBefore.rows);
      expect((await vectors.search({ vector, limit: 1 })).map((hit) => hit.documentId)).toEqual(["baseline_live"]);
    }
    const ingestion = new IngestionService(repo, blobs, createParserRegistry([new NativeTextParser()]),
      (text) => text.split(/\s+/).length,
      { name: "test", model: "test", version: "1", dimensions: 384, embed: async (texts) => texts.map(() => vector) },
      vectors, { MAX_EXTRACT_BYTES: 10000, MAX_SPREADSHEET_CELLS: 100, MAX_CHUNKS_PER_DOCUMENT: 100, EMBEDDING_BATCH_SIZE: 32 });
    // Continue the upgraded live source's lifecycle: the first scanned version
    // replaces this baseline, keeping one live ANN candidate throughout.
    const initialSource = await LocalDirectorySource.create({ root: sourceRoot, maxDepth: 0 });
    await repo.recordSourceFile({ sourceId: initialSource.sourceId, relativePath: "guide.md",
      sha256: "baseline_live", documentId: "baseline_live", lastOutcome: "imported", scanCycle: "before-upgrade" });
    let liveId = "baseline_live";

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
      expect(rows.rows).toHaveLength(version + 3);
      for (const row of rows.rows) {
        expect(Number(row.cleared)).toBe(row.document_id === liveId ? 0 : 1);
      }
    }

    // A retired worker may have produced vectors before replacement and resume here.
    const retired = await client.execute("SELECT c.id FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.deleted_at IS NOT NULL");
    expect(retired.rows).toHaveLength(13);
    await vectors.insert(retired.rows.map((row) => ({ chunkId: String(row.id), vector })));
    const resurrected = await client.execute("SELECT COUNT(*) AS n FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.deleted_at IS NOT NULL AND c.embedding IS NOT NULL");
    expect(Number(resurrected.rows[0]!.n)).toBe(0);
    expect((await vectors.search({ vector, limit: 1 })).map((hit) => hit.documentId)).toEqual([liveId]);
    expect((await lexical.search({ query: "seeds", limit: 20 })).map((hit) => hit.documentId)).toEqual([liveId]);
    expect(Number((await client.execute("SELECT COUNT(*) AS n FROM document_revisions")).rows[0]!.n)).toBe(14);
    expect(Number((await client.execute("SELECT COUNT(*) AS n FROM document_chunks_fts")).rows[0]!.n)).toBe(14);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
