import postgres from "postgres";
import {
  migratePostgres,
  PostgresKnowledgeRepository,
} from "@mcp-knowledge/db";
import {
  PgVectorIndex,
  PostgresLexicalIndex,
} from "@mcp-knowledge/retrieval";
import { newId } from "@mcp-knowledge/core";

const PG_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mcp_knowledge";

async function waitForPostgres(url: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const sql = postgres(url, { connect_timeout: 2, max: 1 });
      await sql`SELECT 1`;
      await sql.end();
      return;
    } catch {
      await Bun.sleep(1000);
    }
  }
  throw new Error(`Failed to connect to PostgreSQL at ${url} after ${maxAttempts} attempts`);
}

async function runE2ETest() {
  console.log("=== PostgreSQL Backend E2E Test ===");
  console.log(`Target: ${PG_URL}`);

  console.log("1. Waiting for PostgreSQL connection...");
  await waitForPostgres(PG_URL);
  console.log("✓ Connected to PostgreSQL.");

  console.log("2. Running PostgreSQL migrations...");
  await migratePostgres(PG_URL);
  console.log("✓ Migrations applied successfully (schema, pgvector extension, HNSW index, tsvector).");

  // Clean test tables to ensure isolation
  const sharedClient = postgres(PG_URL);
  await sharedClient`TRUNCATE TABLE collections, documents, document_revisions, document_chunks, ingestion_jobs, archive_imports, api_keys, source_scan_state, source_files CASCADE`;
  console.log("✓ Test tables truncated for clean test execution.");

  const repo = new PostgresKnowledgeRepository(sharedClient);
  const vectorIndex = new PgVectorIndex(sharedClient);
  const lexicalIndex = new PostgresLexicalIndex(sharedClient);

  try {
    console.log("3. Testing Repository: Collections...");
    const col = await repo.createCollection({ name: "Engineering Docs", description: "Technical docs" });
    if (!col.id || col.name !== "Engineering Docs") throw new Error("Collection creation failed");
    const listedCols = await repo.listCollections();
    if (!listedCols.some((c) => c.id === col.id)) throw new Error("List collections missing created item");
    console.log("✓ Collection CRUD verified.");

    console.log("4. Testing Repository: Documents and Revisions...");
    const docId = newId("doc");
    const revId = newId("rev");
    const created = await repo.createDocument({
      documentId: docId,
      revisionId: revId,
      collectionId: col.id,
      originalFilename: "specs-v1.md",
      mimeType: "text/markdown",
      extension: ".md",
      sizeBytes: 1024,
      sha256: `sha_${Date.now()}`,
      metadata: { department: "engineering", year: 2026 },
      storageKey: `blobs/${docId}/original`,
    });
    if (created.document.id !== docId || created.revision !== 1) throw new Error("Document creation failed");

    const fetchedDoc = await repo.getDocument(docId);
    if (!fetchedDoc || fetchedDoc.title !== undefined) throw new Error("Fetched document mismatch");
    console.log("✓ Document and revision persistence verified.");

    console.log("5. Testing Repository: Chunks...");
    const chk1 = newId("chk");
    const chk2 = newId("chk");
    const chunks = [
      {
        id: chk1,
        collectionId: col.id,
        documentId: docId,
        revisionId: revId,
        sequence: 0,
        content: "Error code ERR_SOCKET_TIMEOUT occurs when the upstream gateway fails to respond.",
        embeddingText: "Error code ERR_SOCKET_TIMEOUT occurs when the upstream gateway fails to respond.",
        headingPath: ["Network", "Errors"],
        location: { line: 1 },
        tokenCount: 15,
        metadata: { category: "network" },
        contentHash: "hash_chunk_1",
        createdAt: new Date(),
      },
      {
        id: chk2,
        collectionId: col.id,
        documentId: docId,
        revisionId: revId,
        sequence: 1,
        content: "Product SKU-9942 is the high-performance quad-core compute module.",
        embeddingText: "Product SKU-9942 is the high-performance quad-core compute module.",
        headingPath: ["Hardware", "SKU"],
        location: { line: 10 },
        tokenCount: 12,
        metadata: { category: "hardware" },
        contentHash: "hash_chunk_2",
        createdAt: new Date(),
      },
    ];
    await repo.replaceChunks(revId, chunks);
    const listedChunks = await repo.listRevisionChunks(revId);
    if (listedChunks.length !== 2) throw new Error(`Expected 2 chunks, got ${listedChunks.length}`);
    console.log("✓ Chunk persistence and retrieval verified.");

    console.log("6. Testing Distributed Job Queue with FOR UPDATE SKIP LOCKED...");
    const job = await repo.enqueueJob({ documentId: docId, revisionId: revId });
    if (job.status !== "queued") throw new Error("Enqueued job has wrong status");

    // Worker 1 claims job
    const claimed1 = await repo.claimJob("worker-1", 60_000);
    if (!claimed1 || claimed1.id !== job.id || claimed1.lockedBy !== "worker-1") {
      throw new Error("Worker 1 failed to claim job");
    }

    // Worker 2 attempts concurrent claim: should get null because of SKIP LOCKED
    const claimed2 = await repo.claimJob("worker-2", 60_000);
    if (claimed2 !== null) throw new Error("Worker 2 should not be able to claim locked job");

    // Complete job
    await repo.completeJob(job.id);
    const completed = await repo.getJob(job.id);
    if (completed?.status !== "completed") throw new Error("Completed job status mismatch");
    console.log("✓ Distributed job locking (SKIP LOCKED) and completion verified.");

    console.log("7. Testing Archive Imports Queue and JSONB Append...");
    const arcId = newId("arc");
    const arc = await repo.createArchiveImport({
      id: arcId,
      originalFilename: "bundle.zip",
      collectionId: col.id,
      stagingStorageKey: `staging/${arcId}`,
      metadata: { source: "batch" },
    });
    const claimedArc = await repo.claimArchiveImport("worker-1", 60_000);
    if (!claimedArc || claimedArc.id !== arcId) throw new Error("Archive import claim failed");

    await repo.appendArchiveImportEntry(arcId, {
      path: "nested/doc1.txt",
      outcome: "extracted",
      documentId: docId,
    });
    const updatedArc = await repo.getArchiveImport(arcId);
    if (updatedArc?.entries.length !== 1 || updatedArc.entries[0]?.path !== "nested/doc1.txt") {
      throw new Error("Archive import JSONB append failed");
    }
    await repo.finishArchiveImport(arcId, "completed");
    console.log("✓ Archive import queue and JSONB operations verified.");

    console.log("8. Testing Vector Index (pgvector 384-d Cosine HNSW)...");
    // Generate synthetic 384-dimensional unit vectors
    const vec1 = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    const vec2 = Array.from({ length: 384 }, (_, i) => (i === 1 ? 1 : 0));
    await vectorIndex.insert([
      { chunkId: chk1, vector: vec1 },
      { chunkId: chk2, vector: vec2 },
    ]);

    // Search query aligned with vec1
    const vHits = await vectorIndex.search({
      vector: vec1,
      limit: 5,
    });
    if (vHits.length === 0) throw new Error("Vector search returned 0 hits");
    if (vHits[0]?.chunkId !== chk1) throw new Error(`Expected top vector hit to be ${chk1}, got ${vHits[0]?.chunkId}`);
    if (vHits[0].score < 0.99) throw new Error(`Expected cosine similarity ~ 1.0, got ${vHits[0].score}`);
    console.log(`✓ pgvector cosine similarity search verified (top score: ${vHits[0].score.toFixed(4)}).`);

    // Test vector search with metadata filters
    const vFilteredHits = await vectorIndex.search({
      vector: vec1,
      filters: [{ field: "category", op: "eq", value: "network" }],
      limit: 5,
    });
    if (vFilteredHits.length === 0 || vFilteredHits[0]?.chunkId !== chk1) {
      throw new Error("Filtered vector search failed");
    }
    console.log("✓ Filtered vector search with metadata verified.");

    console.log("9. Testing Lexical Index (tsvector simple dictionary without stemming)...");
    const lHits = await lexicalIndex.search({
      query: "ERR_SOCKET_TIMEOUT",
      limit: 5,
    });
    if (lHits.length === 0) throw new Error("Lexical search for ERR_SOCKET_TIMEOUT returned 0 hits");
    if (lHits[0]?.chunkId !== chk1) throw new Error(`Expected chunk ${chk1}, got ${lHits[0]?.chunkId}`);

    // Test lexical search with metadata filters
    const lFilteredHits = await lexicalIndex.search({
      query: "ERR_SOCKET_TIMEOUT",
      filters: [{ field: "category", op: "eq", value: "network" }],
      limit: 5,
    });
    if (lFilteredHits.length === 0 || lFilteredHits[0]?.chunkId !== chk1) {
      throw new Error("Filtered lexical search failed");
    }
    console.log("✓ Filtered lexical search with metadata verified.");

    const skuHits = await lexicalIndex.search({
      query: "SKU-9942 compute",
      limit: 5,
    });
    if (skuHits.length === 0) throw new Error("Lexical search for SKU-9942 returned 0 hits");
    if (skuHits[0]?.chunkId !== chk2) throw new Error(`Expected chunk ${chk2}, got ${skuHits[0]?.chunkId}`);
    console.log("✓ Postgres tsvector lexical search verified for exact technical keywords and SKUs.");

    console.log("10. Testing Soft Delete and Purge...");
    await repo.softDeleteDocument(docId);
    const deletedDoc = await repo.getDocument(docId);
    if (deletedDoc !== null) throw new Error("Soft deleted document still returned by getDocument");

    // Vector search excludes deleted documents
    const vHitsAfterDelete = await vectorIndex.search({ vector: vec1, limit: 5 });
    if (vHitsAfterDelete.some((h) => h.documentId === docId)) {
      throw new Error("Vector search returned chunk of deleted document");
    }

    const purgedCount = await repo.purgeDocuments();
    if (purgedCount === 0) throw new Error("Purge documents returned 0");
    console.log(`✓ Soft deletion and purge verified (purged ${purgedCount} documents).`);

    console.log("\n==============================================");
    console.log(" ALL POSTGRESQL BACKEND TESTS PASSED CLEANLY!");
    console.log("==============================================\n");
  } finally {
    await sharedClient.end();
  }
}

await runE2ETest();
