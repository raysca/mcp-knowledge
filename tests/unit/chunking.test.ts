import { describe, expect, test } from "bun:test";
import { chunkBlocks } from "../../packages/core/src/chunking/chunk.ts";
import type { DocumentBlock } from "../../packages/core/src/domain/normalized.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const countTokens = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe("chunkBlocks", () => {
  test("keeps heading path on chunks and prefixes embeddingText", () => {
    const blocks: DocumentBlock[] = [
      { type: "heading", level: 1, text: "Alpha" },
      { type: "paragraph", text: words(80) },
    ];
    const chunks = chunkBlocks(blocks, {
      title: "Doc",
      revisionHash: "abc",
      countTokens,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toEqual(["Alpha"]);
    expect(chunks[0]!.content.startsWith("w0")).toBe(true);
    expect(chunks[0]!.embeddingText).toContain("Document: Doc");
    expect(chunks[0]!.embeddingText).toContain("Section: Alpha");
    expect(chunks[0]!.id.startsWith("chk_")).toBe(true);
  });

  test("splits when a section exceeds the 220-token max", () => {
    const blocks: DocumentBlock[] = [{ type: "paragraph", text: words(400) }];
    const chunks = chunkBlocks(blocks, {
      title: "Doc",
      revisionHash: "abc",
      countTokens,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(220);
    }
  });

  test("ids are deterministic for the same input", () => {
    const blocks: DocumentBlock[] = [{ type: "paragraph", text: "same text" }];
    const a = chunkBlocks(blocks, { title: "Doc", revisionHash: "abc", countTokens });
    const b = chunkBlocks(blocks, { title: "Doc", revisionHash: "abc", countTokens });
    expect(a[0]!.id).toBe(b[0]!.id);
  });
});
