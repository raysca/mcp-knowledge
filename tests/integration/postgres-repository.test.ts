import { describe, expect, test, beforeAll, afterAll } from "bun:test";
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

async function isPostgresReachable(): Promise<boolean> {
  const sql = postgres(PG_URL, { connect_timeout: 1, max: 1 });
  try {
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    await sql.end({ timeout: 0 }).catch(() => {});
    return false;
  }
}

const hasPostgres = await isPostgresReachable();

describe.skipIf(!hasPostgres)("PostgreSQL storage & retrieval backend", () => {
  let sharedClient: postgres.Sql;
  let repo: PostgresKnowledgeRepository;
  let vectorIndex: PgVectorIndex;
  let lexicalIndex: PostgresLexicalIndex;

  beforeAll(async () => {
    await migratePostgres(PG_URL);

    sharedClient = postgres(PG_URL);
    await sharedClient`TRUNCATE TABLE collections, documents, document_revisions, document_chunks, ingestion_jobs, archive_imports, api_keys, source_scan_state, source_files CASCADE`;

    repo = new PostgresKnowledgeRepository(sharedClient);
    vectorIndex = new PgVectorIndex(sharedClient);
    lexicalIndex = new PostgresLexicalIndex(sharedClient);
  });

  afterAll(async () => {
    if (sharedClient) await sharedClient.end();
  });

  test("collections CRUD", async () => {
    const col = await repo.createCollection({ name: "Postgres Tests", description: "Integration tests" });
    expect(col.id).toBeTruthy();
    expect(col.name).toBe("Postgres Tests");

    const fetched = await repo.getCollection(col.id);
    expect(fetched?.name).toBe("Postgres Tests");

    const updated = await repo.updateCollection(col.id, { name: "Updated Tests" });
    expect(updated.name).toBe("Updated Tests");

    const count = await repo.countDocumentsInCollection(col.id);
    expect(count).toBe(0);
  });

  test("documents, revisions, and chunks", async () => {
    const docId = newId("doc");
    const revId = newId("rev");
    const { document, revision } = await repo.createDocument({
      documentId: docId,
      revisionId: revId,
      originalFilename: "network-guide.md",
      mimeType: "text/markdown",
      sizeBytes: 2048,
      sha256: `sha_${Date.now()}`,
      metadata: { env: "prod", version: 2 },
      storageKey: `blobs/${docId}/original`,
    });
    expect(document.id).toBe(docId);
    expect(revision).toBe(1);

    const chk1 = newId("chk");
    const chk2 = newId("chk");
    await repo.replaceChunks(revId, [
      {
        id: chk1,
        documentId: docId,
        revisionId: revId,
        sequence: 0,
        content: "Gateway returned ERR_GATEWAY_TIMEOUT on port 8080.",
        embeddingText: "Gateway returned ERR_GATEWAY_TIMEOUT on port 8080.",
        headingPath: ["Errors"],
        tokenCount: 10,
        metadata: { service: "api" },
        contentHash: "hash_1",
        createdAt: new Date(),
      },
      {
        id: chk2,
        documentId: docId,
        revisionId: revId,
        sequence: 1,
        content: "Database connector SKU-CORE-99 operates on primary cluster.",
        embeddingText: "Database connector SKU-CORE-99 operates on primary cluster.",
        headingPath: ["Hardware"],
        tokenCount: 10,
        metadata: { service: "db" },
        contentHash: "hash_2",
        createdAt: new Date(),
      },
    ]);

    const chunks = await repo.listRevisionChunks(revId);
    expect(chunks.length).toBe(2);

    // Test pgvector index
    const vec1 = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    const vec2 = Array.from({ length: 384 }, (_, i) => (i === 1 ? 1 : 0));
    await vectorIndex.insert([
      { chunkId: chk1, vector: vec1 },
      { chunkId: chk2, vector: vec2 },
    ]);

    const vHits = await vectorIndex.search({ vector: vec1, limit: 2 });
    expect(vHits.length).toBeGreaterThanOrEqual(1);
    expect(vHits[0]!.chunkId).toBe(chk1);
    expect(vHits[0]!.score).toBeGreaterThan(0.99);

    const vFilteredHits = await vectorIndex.search({
      vector: vec1,
      filters: [{ field: "service", op: "eq", value: "api" }],
      limit: 2,
    });
    expect(vFilteredHits.length).toBe(1);
    expect(vFilteredHits[0]!.chunkId).toBe(chk1);

    // Test Postgres tsvector lexical index
    const lHits = await lexicalIndex.search({ query: "ERR_GATEWAY_TIMEOUT", limit: 2 });
    expect(lHits.length).toBe(1);
    expect(lHits[0]!.chunkId).toBe(chk1);

    const lFilteredHits = await lexicalIndex.search({
      query: "ERR_GATEWAY_TIMEOUT",
      filters: [{ field: "service", op: "eq", value: "api" }],
      limit: 2,
    });
    expect(lFilteredHits.length).toBe(1);
    expect(lFilteredHits[0]!.chunkId).toBe(chk1);

    const skuHits = await lexicalIndex.search({ query: "SKU-CORE-99", limit: 2 });
    expect(skuHits.length).toBe(1);
    expect(skuHits[0]!.chunkId).toBe(chk2);
  });

  test("distributed job queue (FOR UPDATE SKIP LOCKED)", async () => {
    const docId = newId("doc");
    const revId = newId("rev");
    await repo.createDocument({
      documentId: docId,
      revisionId: revId,
      originalFilename: "job-test.md",
      mimeType: "text/markdown",
      sizeBytes: 100,
      sha256: `sha_job_${Date.now()}`,
      metadata: {},
      storageKey: `blobs/${docId}/original`,
    });

    const job = await repo.enqueueJob({ documentId: docId, revisionId: revId });
    expect(job.status).toBe("queued");

    // Worker 1 claims
    const claim1 = await repo.claimJob("worker-1", 60_000);
    expect(claim1?.id).toBe(job.id);
    expect(claim1?.lockedBy).toBe("worker-1");

    // Worker 2 attempts claim while locked -> null
    const claim2 = await repo.claimJob("worker-2", 60_000);
    expect(claim2).toBeNull();

    await repo.completeJob(job.id);
    const completed = await repo.getJob(job.id);
    expect(completed?.status).toBe("completed");
  });
});
