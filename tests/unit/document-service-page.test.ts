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

function fixture(key?: Uint8Array) {
  let revisionId = "rev_first";
  const repo = {
    async getDocument() { return { id: "doc_a", currentRevisionId: revisionId }; },
    async getRevision(id: string) { return { id, normalizedStorageKey: `normalized-${id}` }; },
  } as unknown as KnowledgeRepository;
  const blobs = {
    async get() { return new Blob([JSON.stringify(normalized)]); },
  } as unknown as BlobStore;
  return {
    service: new DocumentService(repo, blobs, 1024, key),
    nextRevision: () => { revisionId = "rev_second"; },
  };
}

describe("DocumentService.normalizedPage", () => {
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
