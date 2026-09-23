import { describe, expect, test } from "bun:test";
import type { BlobStore, KnowledgeRepository } from "../../packages/core/src/ports.ts";
import { DocumentService } from "../../packages/core/src/services/document-service.ts";

const normalized = {
  metadata: {},
  blocks: [
    { type: "heading", level: 1, text: "Tools" },
    { type: "paragraph", text: "Hammer" },
    { type: "heading", level: 1, text: "Paint" },
    { type: "paragraph", text: "Primer" },
  ],
};

function fixture(key?: Uint8Array, document: object = normalized) {
  let revisionId = "rev_first";
  const repo = {
    async getDocument() { return { id: "doc_a", currentRevisionId: revisionId }; },
    async getRevision(id: string) { return { id, normalizedStorageKey: `normalized-${id}` }; },
  } as unknown as KnowledgeRepository;
  const blobs = {
    async get() { return new Blob([JSON.stringify(document)]); },
  } as unknown as BlobStore;
  return {
    service: new DocumentService(repo, blobs, 1024, key),
    nextRevision: () => { revisionId = "rev_second"; },
  };
}

describe("DocumentService.normalizedPage", () => {
  test("omitted block limit returns all 60 tiny blocks when they fit", async () => {
    const blocks = Array.from({ length: 60 }, (_, index) => ({ type: "paragraph", text: `p${index}` }));
    const { service } = fixture(undefined, { metadata: {}, blocks });
    const page = await service.normalizedPage("doc_a", { maxChars: 5_000 });
    expect(page.returnedBlocks).toBe(60);
    expect(page.totalBlocks).toBe(60);
    expect(page.truncated).toBe(false);
    expect((JSON.parse(page.body) as { blocks: unknown[] }).blocks).toHaveLength(60);
  });

  test("omitted block limit stops at the largest whole-block prefix within maxChars", async () => {
    const blocks = Array.from({ length: 80 }, (_, index) => ({ type: "paragraph", text: `p${index}` }));
    const document = { metadata: {}, blocks };
    const ceiling = JSON.stringify({ metadata: {}, blocks: blocks.slice(0, 61) }).length;
    const { service } = fixture(undefined, document);
    const page = await service.normalizedPage("doc_a", { maxChars: ceiling });
    expect(page.body.length).toBe(ceiling);
    expect(page.returnedBlocks).toBe(61);
    expect(page.totalBlocks).toBe(80);
    expect(page.truncated).toBe(true);
    expect((JSON.parse(page.body) as { blocks: unknown[] }).blocks).toHaveLength(61);
  });

  test("normalized blob read and parse failures have fixed public errors", async () => {
    for (const failure of [
      new Error("blob not found: private/storage/key"),
      new Blob(["not-json"]),
      new Blob(["null"]),
    ]) {
      const repo = {
        async getDocument() { return { id: "doc_a", currentRevisionId: "rev_a" }; },
        async getRevision() { return { id: "rev_a", normalizedStorageKey: "private/storage/key" }; },
      } as unknown as KnowledgeRepository;
      const blobs = {
        async get() {
          if (failure instanceof Error) throw failure;
          return failure;
        },
      } as unknown as BlobStore;
      const service = new DocumentService(repo, blobs, 1024);
      await expect(service.normalizedPage("doc_a"))
        .rejects.toMatchObject({ code: "DOCUMENT_CONTENT_UNAVAILABLE", message: "Normalized document content is unavailable." });
    }
  });

  test("a cursor becomes stale when the current revision changes", async () => {
    const { service, nextRevision } = fixture();
    const first = await service.normalizedPage("doc_a", { blockLimit: 1, maxChars: 200 });
    expect(first.nextBlockCursor).toBeTruthy();
    nextRevision();
    await expect(service.normalizedPage("doc_a", { cursor: first.nextBlockCursor, maxChars: 200 }))
      .rejects.toMatchObject({ code: "CURSOR_STALE" });
  });

  test("random instance keys invalidate cursors from another local service", async () => {
    const first = fixture().service;
    const second = fixture().service;
    const page = await first.normalizedPage("doc_a", { blockLimit: 1, maxChars: 200 });
    await expect(second.normalizedPage("doc_a", { cursor: page.nextBlockCursor, maxChars: 200 }))
      .rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  test("an injected key keeps cursors usable across service instances", async () => {
    const key = Buffer.alloc(32, 7);
    const first = fixture(key).service;
    const second = fixture(key).service;
    const page = await first.normalizedPage("doc_a", { blockLimit: 1, maxChars: 200 });
    const continued = await second.normalizedPage("doc_a", { cursor: page.nextBlockCursor, maxChars: 200 });
    expect((JSON.parse(continued.body) as { blocks: Array<{ text: string }> }).blocks[0]?.text).toBe("Hammer");
  });

  test("unsafe service limits are rejected by the core pager", async () => {
    const { service } = fixture();
    await expect(service.normalizedPage("doc_a", { blockLimit: 0, maxChars: 200 }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(service.normalizedPage("doc_a", { blockLimit: 1, maxChars: 0 }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
