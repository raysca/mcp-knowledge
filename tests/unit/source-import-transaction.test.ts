import { describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommitSourceImportInput,
  PreparedSourceDocument,
} from "../../packages/core/src/domain/source.ts";
import { createKnowledgeRepository, migrateLibsql } from "../../packages/db/src/index.ts";

type Repository = ReturnType<typeof createKnowledgeRepository>;

async function withRepository(
  run: (repo: Repository, client: Client) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-source-import-"));
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

function preparedDocument(input: {
  documentId: string;
  revisionId: string;
  sha256: string;
  originalFilename: string;
}): PreparedSourceDocument {
  return {
    ...input,
    mimeType: "text/markdown",
    extension: "md",
    sizeBytes: 12,
    metadata: { source: "startup-directory" },
    storageKey: `documents/${input.documentId}/revisions/${input.revisionId}/original`,
  };
}

async function createOwnedDocument(
  repo: Repository,
  input: {
    sourceId: string;
    relativePath: string;
    documentId: string;
    sha256: string;
  },
): Promise<void> {
  await repo.createDocument({
    documentId: input.documentId,
    revisionId: `rev_${input.documentId}`,
    originalFilename: input.relativePath,
    mimeType: "text/markdown",
    extension: "md",
    sizeBytes: 3,
    sha256: input.sha256,
    metadata: {},
    storageKey: `documents/${input.documentId}/revisions/rev_${input.documentId}/original`,
  });
  await repo.recordSourceFile({
    sourceId: input.sourceId,
    relativePath: input.relativePath,
    sha256: input.sha256,
    documentId: input.documentId,
    lastOutcome: "imported",
    scanCycle: "cycle-old",
  });
}

describe("atomic source document commit", () => {
  test("creates one processing document, revision, queued job, and owned source row", async () => {
    await withRepository(async (repo) => {
      const input: CommitSourceImportInput = {
        mode: "import",
        sourceId: "source-a",
        relativePath: "new.md",
        scanCycle: "cycle-a",
        sha256: "sha-new",
        prepared: preparedDocument({
          documentId: "doc_new",
          revisionId: "rev_new",
          sha256: "sha-new",
          originalFilename: "new.md",
        }),
      };

      const result = await repo.commitSourceImport(input);

      expect(result).toEqual({
        outcome: "imported",
        documentId: "doc_new",
        jobId: expect.stringMatching(/^job_/),
      });
      expect(await repo.getDocument("doc_new")).toEqual(
        expect.objectContaining({
          id: "doc_new",
          currentRevisionId: "rev_new",
          status: "processing",
          sha256: "sha-new",
        }),
      );
      expect(await repo.getRevision("rev_new")).toEqual(
        expect.objectContaining({
          documentId: "doc_new",
          revision: 1,
          storageKey: "documents/doc_new/revisions/rev_new/original",
        }),
      );
      expect(await repo.listJobs()).toEqual([
        expect.objectContaining({
          id: result.outcome === "imported" ? result.jobId : "unreachable",
          documentId: "doc_new",
          revisionId: "rev_new",
          status: "queued",
          attempt: 0,
          maxAttempts: 3,
        }),
      ]);
      expect(await repo.getSourceFile("source-a", "new.md")).toEqual(
        expect.objectContaining({
          sha256: "sha-new",
          documentId: "doc_new",
          lastOutcome: "imported",
          scanCycle: "cycle-a",
        }),
      );
    });
  });

  test("replaces a same-hash owned document across a rename", async () => {
    await withRepository(async (repo) => {
      await createOwnedDocument(repo, {
        sourceId: "source-a",
        relativePath: "old-name.md",
        documentId: "doc_old",
        sha256: "sha-same",
      });

      const result = await repo.commitSourceImport({
        mode: "import",
        sourceId: "source-a",
        relativePath: "new-name.md",
        scanCycle: "cycle-new",
        sha256: "sha-same",
        replaceDocumentId: "doc_old",
        prepared: preparedDocument({
          documentId: "doc_renamed",
          revisionId: "rev_renamed",
          sha256: "sha-same",
          originalFilename: "new-name.md",
        }),
      });

      expect(result).toEqual({
        outcome: "imported",
        documentId: "doc_renamed",
        jobId: expect.stringMatching(/^job_/),
        retiredDocumentId: "doc_old",
      });
      expect(await repo.getDocument("doc_old")).toBeNull();
      expect(await repo.getDocument("doc_renamed")).toEqual(
        expect.objectContaining({ status: "processing", sha256: "sha-same" }),
      );
      expect(await repo.getSourceFile("source-a", "old-name.md")).toBeNull();
      expect(await repo.getSourceFile("source-a", "new-name.md")).toEqual(
        expect.objectContaining({
          documentId: "doc_renamed",
          lastOutcome: "imported",
          scanCycle: "cycle-new",
        }),
      );
      expect(await repo.listJobs()).toHaveLength(1);
    });
  });

  test("retires only the changed owned document when its new hash is a duplicate", async () => {
    await withRepository(async (repo) => {
      await createOwnedDocument(repo, {
        sourceId: "source-a",
        relativePath: "changed.md",
        documentId: "doc_old",
        sha256: "sha-old",
      });
      await repo.createDocument({
        documentId: "doc_duplicate",
        revisionId: "rev_duplicate",
        originalFilename: "elsewhere.md",
        mimeType: "text/markdown",
        extension: "md",
        sizeBytes: 8,
        sha256: "sha-existing",
        metadata: {},
        storageKey: "documents/doc_duplicate/revisions/rev_duplicate/original",
      });

      const result = await repo.commitSourceImport({
        mode: "duplicate",
        sourceId: "source-a",
        relativePath: "changed.md",
        scanCycle: "cycle-new",
        sha256: "sha-existing",
        duplicateDocumentId: "doc_duplicate",
        replaceDocumentId: "doc_old",
      });

      expect(result).toEqual({
        outcome: "duplicate",
        duplicateDocumentId: "doc_duplicate",
        retiredDocumentId: "doc_old",
      });
      expect(await repo.getDocument("doc_old")).toBeNull();
      expect(await repo.getDocument("doc_duplicate")).toEqual(
        expect.objectContaining({ id: "doc_duplicate", sha256: "sha-existing" }),
      );
      expect((await repo.listDocuments({ limit: 10 })).items.map((row) => row.id)).toEqual([
        "doc_duplicate",
      ]);
      expect(await repo.getSourceFile("source-a", "changed.md")).toEqual(
        expect.objectContaining({
          sha256: "sha-existing",
          documentId: undefined,
          lastOutcome: "duplicate",
          scanCycle: "cycle-new",
        }),
      );
      expect(await repo.listJobs()).toEqual([]);
    });
  });

  test("rejects a stale import when the destination path has newer ownership", async () => {
    await withRepository(async (repo) => {
      await createOwnedDocument(repo, {
        sourceId: "source-a",
        relativePath: "old-name.md",
        documentId: "doc_old",
        sha256: "sha-old",
      });
      await createOwnedDocument(repo, {
        sourceId: "source-a",
        relativePath: "new-name.md",
        documentId: "doc_current",
        sha256: "sha-current",
      });

      await expect(
        repo.commitSourceImport({
          mode: "import",
          sourceId: "source-a",
          relativePath: "new-name.md",
          scanCycle: "cycle-new",
          sha256: "sha-new",
          replaceDocumentId: "doc_old",
          prepared: preparedDocument({
            documentId: "doc_stale",
            revisionId: "rev_stale",
            sha256: "sha-new",
            originalFilename: "new-name.md",
          }),
        }),
      ).rejects.toThrow("SOURCE_DESTINATION_OWNED");

      expect(await repo.getDocument("doc_old")).toEqual(
        expect.objectContaining({ id: "doc_old", sha256: "sha-old" }),
      );
      expect(await repo.getDocument("doc_current")).toEqual(
        expect.objectContaining({ id: "doc_current", sha256: "sha-current" }),
      );
      expect(await repo.getDocument("doc_stale")).toBeNull();
      expect(await repo.getSourceFile("source-a", "old-name.md")).toEqual(
        expect.objectContaining({ documentId: "doc_old", sha256: "sha-old" }),
      );
      expect(await repo.getSourceFile("source-a", "new-name.md")).toEqual(
        expect.objectContaining({ documentId: "doc_current", sha256: "sha-current" }),
      );
      expect(await repo.listJobs()).toEqual([]);
    });
  });

  test("rejects a duplicate that aliases the replacement document", async () => {
    await withRepository(async (repo) => {
      await createOwnedDocument(repo, {
        sourceId: "source-a",
        relativePath: "owned.md",
        documentId: "doc_alias",
        sha256: "sha-alias",
      });

      await expect(
        repo.commitSourceImport({
          mode: "duplicate",
          sourceId: "source-a",
          relativePath: "owned.md",
          scanCycle: "cycle-new",
          sha256: "sha-alias",
          duplicateDocumentId: "doc_alias",
          replaceDocumentId: "doc_alias",
        }),
      ).rejects.toThrow("DUPLICATE_DOCUMENT_EQUALS_REPLACEMENT");

      expect(await repo.getDocument("doc_alias")).toEqual(
        expect.objectContaining({ id: "doc_alias", sha256: "sha-alias" }),
      );
      expect(await repo.getSourceFile("source-a", "owned.md")).toEqual(
        expect.objectContaining({ documentId: "doc_alias", sha256: "sha-alias" }),
      );
      expect(await repo.listJobs()).toEqual([]);
    });
  });

  test("turns an import into the same safe duplicate result when the hash became live", async () => {
    await withRepository(async (repo) => {
      await createOwnedDocument(repo, {
        sourceId: "source-a",
        relativePath: "changed.md",
        documentId: "doc_old",
        sha256: "sha-old",
      });
      await repo.createDocument({
        documentId: "doc_race_winner",
        revisionId: "rev_race_winner",
        originalFilename: "winner.md",
        mimeType: "text/markdown",
        extension: "md",
        sizeBytes: 8,
        sha256: "sha-race",
        metadata: {},
        storageKey: "documents/doc_race_winner/revisions/rev_race_winner/original",
      });

      const result = await repo.commitSourceImport({
        mode: "import",
        sourceId: "source-a",
        relativePath: "changed.md",
        scanCycle: "cycle-new",
        sha256: "sha-race",
        replaceDocumentId: "doc_old",
        prepared: preparedDocument({
          documentId: "doc_loser",
          revisionId: "rev_loser",
          sha256: "sha-race",
          originalFilename: "changed.md",
        }),
      });

      expect(result).toEqual({
        outcome: "duplicate",
        duplicateDocumentId: "doc_race_winner",
        retiredDocumentId: "doc_old",
      });
      expect(await repo.getDocument("doc_old")).toBeNull();
      expect(await repo.getDocument("doc_race_winner")).not.toBeNull();
      expect(await repo.getDocument("doc_loser")).toBeNull();
      expect(await repo.getRevision("rev_loser")).toBeNull();
      expect(await repo.listJobs()).toEqual([]);
      expect(await repo.getSourceFile("source-a", "changed.md")).toEqual(
        expect.objectContaining({
          sha256: "sha-race",
          documentId: undefined,
          lastOutcome: "duplicate",
        }),
      );
    });
  });

  test("rolls back the retired document and ownership mapping after a statement failure", async () => {
    await withRepository(async (repo, client) => {
      await createOwnedDocument(repo, {
        sourceId: "source-a",
        relativePath: "old-name.md",
        documentId: "doc_old",
        sha256: "sha-old",
      });
      await client.execute(`CREATE TRIGGER fail_source_revision
BEFORE INSERT ON document_revisions
WHEN NEW.id = 'rev_fail'
BEGIN
  SELECT RAISE(FAIL, 'injected revision failure');
END`);

      await expect(
        repo.commitSourceImport({
          mode: "import",
          sourceId: "source-a",
          relativePath: "new-name.md",
          scanCycle: "cycle-new",
          sha256: "sha-new",
          replaceDocumentId: "doc_old",
          prepared: preparedDocument({
            documentId: "doc_fail",
            revisionId: "rev_fail",
            sha256: "sha-new",
            originalFilename: "new-name.md",
          }),
        }),
      ).rejects.toThrow("injected revision failure");

      expect(await repo.getDocument("doc_old")).toEqual(
        expect.objectContaining({ id: "doc_old", sha256: "sha-old" }),
      );
      expect(await repo.getSourceFile("source-a", "old-name.md")).toEqual(
        expect.objectContaining({ documentId: "doc_old", sha256: "sha-old" }),
      );
      expect(await repo.getSourceFile("source-a", "new-name.md")).toBeNull();
      expect(await repo.getDocument("doc_fail")).toBeNull();
      expect(await repo.listJobs()).toEqual([]);
      const inserted = await client.execute(
        "SELECT COUNT(*) AS n FROM documents WHERE id = 'doc_fail'",
      );
      expect(Number(inserted.rows[0]!.n)).toBe(0);
    });
  });

  test("lists original and normalized blob keys for every revision of one document", async () => {
    await withRepository(async (repo, client) => {
      await repo.createDocument({
        documentId: "doc_keys",
        revisionId: "rev_keys_1",
        originalFilename: "keys.md",
        mimeType: "text/markdown",
        extension: "md",
        sizeBytes: 4,
        sha256: "sha-keys",
        metadata: {},
        storageKey: "original-1",
      });
      await repo.updateRevision("rev_keys_1", {
        parserName: "parser",
        parserVersion: "1",
        chunkerName: "chunker",
        chunkerVersion: "1",
        embeddingModel: "model",
        embeddingDimensions: 3,
        embeddingVersion: "1",
        normalizedStorageKey: "normalized-1",
        chunkCount: 1,
      });
      await client.execute({
        sql: `INSERT INTO document_revisions (
  id, document_id, revision, storage_key, sha256, size_bytes,
  parser_name, parser_version, chunker_name, chunker_version,
  embedding_model, embedding_dimensions, embedding_version,
  normalized_storage_key, chunk_count, created_at
) VALUES (?, ?, 2, ?, ?, ?, 'parser', '1', 'chunker', '1', 'model', 3, '1', ?, 1, ?)`,
        args: ["rev_keys_2", "doc_keys", "original-2", "sha-keys", 4, "normalized-2", Date.now()],
      });
      await repo.createDocument({
        documentId: "doc_other",
        revisionId: "rev_other",
        originalFilename: "other.md",
        mimeType: "text/markdown",
        extension: "md",
        sizeBytes: 5,
        sha256: "sha-other",
        metadata: {},
        storageKey: "other-original",
      });

      const keys = await repo.listDocumentBlobKeys("doc_keys");

      expect(keys).toHaveLength(4);
      expect(keys).toEqual(
        expect.arrayContaining([
          "original-1",
          "normalized-1",
          "original-2",
          "normalized-2",
        ]),
      );
      expect(keys).not.toContain("other-original");
    });
  });
});
