import { describe, expect, test } from "bun:test";
import {
  IngestionService,
  type BlobStore,
  type DocumentParser,
  type Embedder,
  type IngestionJob,
  type KnowledgeRepository,
  type ParserRegistry,
  type VectorIndex,
} from "../../packages/core/src/index.ts";

type Stage =
  | "blob.put"
  | "replaceChunks"
  | "embed"
  | "vectors.insert"
  | "updateRevision"
  | "setDocumentStatus"
  | "completeJob";

function cancellationHarness(pauseAt: Stage) {
  const calls: Stage[] = [];
  let resolveReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  let resolveRelease!: () => void;
  const release = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  const stage = async (name: Stage) => {
    calls.push(name);
    if (name === pauseAt) {
      resolveReached();
      await release;
    }
  };
  const now = new Date();
  const repo = {
    async getDocument() {
      return {
        id: "doc_cancel",
        currentRevisionId: "rev_cancel",
        originalFilename: "cancel.txt",
        mimeType: "text/plain",
        extension: "txt",
        sizeBytes: 10,
        sha256: "doc-sha",
        status: "processing" as const,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      };
    },
    async getRevision() {
      return {
        id: "rev_cancel",
        documentId: "doc_cancel",
        revision: 1,
        storageKey: "original",
        sha256: "revision-sha",
        sizeBytes: 10,
        parserName: "",
        parserVersion: "",
        chunkerName: "",
        chunkerVersion: "",
        embeddingModel: "",
        embeddingDimensions: 0,
        embeddingVersion: "",
        chunkCount: 0,
        createdAt: now,
      };
    },
    async replaceChunks() {
      await stage("replaceChunks");
    },
    async updateRevision() {
      await stage("updateRevision");
    },
    async setDocumentStatus() {
      await stage("setDocumentStatus");
    },
    async completeJob() {
      await stage("completeJob");
    },
  } as unknown as KnowledgeRepository;
  const blobs = {
    async get() {
      return new Blob(["source"]);
    },
    async put() {
      await stage("blob.put");
    },
  } as unknown as BlobStore;
  const parser = {
    name: "test-parser",
    version: "1",
    supports: () => true,
    async parse() {
      return { metadata: {}, blocks: [{ type: "paragraph" as const, text: "alpha ".repeat(80) }] };
    },
  } satisfies DocumentParser;
  const registry = { find: () => parser } satisfies ParserRegistry;
  const embedder = {
    name: "test-embedder",
    model: "test-model",
    version: "1",
    dimensions: 2,
    async embed(texts: string[]) {
      await stage("embed");
      return texts.map(() => [0, 0]);
    },
  } satisfies Embedder;
  const vectors = {
    async insert() {
      await stage("vectors.insert");
    },
  } as unknown as VectorIndex;
  const service = new IngestionService(
    repo,
    blobs,
    registry,
    (text) => text.split(/\s+/).filter(Boolean).length,
    embedder,
    vectors,
    {
      MAX_EXTRACT_BYTES: 1_000_000,
      MAX_SPREADSHEET_CELLS: 1_000,
      MAX_CHUNKS_PER_DOCUMENT: 100,
      EMBEDDING_BATCH_SIZE: 32,
    },
  );
  const job: IngestionJob = {
    id: "job_cancel",
    documentId: "doc_cancel",
    revisionId: "rev_cancel",
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
  };
  return { calls, job, reached, release: resolveRelease, service };
}

describe("IngestionService cancellation", () => {
  test.each([
    { pauseAt: "blob.put", want: ["blob.put"] },
    { pauseAt: "replaceChunks", want: ["blob.put", "replaceChunks"] },
    { pauseAt: "embed", want: ["blob.put", "replaceChunks", "embed"] },
    { pauseAt: "vectors.insert", want: ["blob.put", "replaceChunks", "embed", "vectors.insert"] },
    {
      pauseAt: "updateRevision",
      want: ["blob.put", "replaceChunks", "embed", "vectors.insert", "updateRevision"],
    },
    {
      pauseAt: "setDocumentStatus",
      want: ["blob.put", "replaceChunks", "embed", "vectors.insert", "updateRevision", "setDocumentStatus"],
    },
  ] satisfies Array<{ pauseAt: Stage; want: Stage[] }>)(
    "does not continue after an abort released from $pauseAt",
    async ({ pauseAt, want }) => {
      const harness = cancellationHarness(pauseAt);
      const controller = new AbortController();
      const processing = harness.service.process(harness.job, controller.signal);

      await harness.reached;
      controller.abort(new DOMException("test stop", "AbortError"));
      harness.release();

      await expect(processing).rejects.toMatchObject({ name: "AbortError" });
      expect(harness.calls).toEqual(want);
    },
  );
});
