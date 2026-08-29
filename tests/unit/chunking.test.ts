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

  test("splitting a large single block doesn't blow up tokenizer calls", () => {
    // Regression: fitPrefix used to shrink one word at a time, re-tokenizing the whole
    // remaining text each step (O(n^2) tokenizer calls). A big single-block document (an
    // entire JSON/XML/TXT file with no paragraph breaks) could block the event loop long
    // enough that even the ingestion timeout couldn't fire. Binary search keeps this bounded.
    let calls = 0;
    const counting = (text: string) => {
      calls++;
      return countTokens(text);
    };
    const big = words(20_000);
    const chunks = chunkBlocks([{ type: "paragraph", text: big }], {
      title: "Doc",
      revisionHash: "abc",
      countTokens: counting,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // Linear decrement would need tens of thousands of calls here; log2(20000) ~= 15 per split.
    expect(calls).toBeLessThan(chunks.length * 50);
  });

  test("merges an under-minimum chunk that isn't the last chunk in the document", () => {
    // Regression: only the very last two packed chunks were ever checked against CHUNK_MIN.
    // A short trailing paragraph under a heading that isn't the document's last heading (here,
    // "A" followed by "B") produced a permanently under-minimum chunk that nothing picked up.
    const blocks: DocumentBlock[] = [
      { type: "heading", level: 1, text: "A" },
      { type: "paragraph", text: words(180) },
      { type: "paragraph", text: words(5) },
      { type: "heading", level: 1, text: "B" },
      { type: "paragraph", text: words(50) },
    ];
    const chunks = chunkBlocks(blocks, { title: "Doc", revisionHash: "abc", countTokens });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.headingPath).toEqual(["A"]);
    expect(chunks[0]!.tokenCount).toBeGreaterThanOrEqual(64);
    expect(chunks[1]!.headingPath).toEqual(["B"]);
  });

  test("ids are deterministic for the same input", () => {
    const blocks: DocumentBlock[] = [{ type: "paragraph", text: "same text" }];
    const a = chunkBlocks(blocks, { title: "Doc", revisionHash: "abc", countTokens });
    const b = chunkBlocks(blocks, { title: "Doc", revisionHash: "abc", countTokens });
    expect(a[0]!.id).toBe(b[0]!.id);
  });
});
