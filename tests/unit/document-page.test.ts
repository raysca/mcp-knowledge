import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { NormalizedDocument } from "../../packages/core/src/domain/normalized.ts";
import {
  decodeBlockCursor,
  encodeBlockCursor,
  pageNormalizedDocument,
} from "../../packages/core/src/services/document-page.ts";

const normalized: NormalizedDocument = {
  title: "Guide",
  metadata: { source: "catalog" },
  blocks: [
    { type: "heading", level: 1, text: "Tools" },
    { type: "paragraph", text: "Hammer" },
    { type: "heading", level: 2, text: "Care" },
    { type: "paragraph", text: "Keep dry" },
    { type: "heading", level: 1, text: "Paint" },
    { type: "paragraph", text: "Primer" },
  ],
};

const cursorKey = Buffer.alloc(32, 0x5a);
const base = { documentId: "doc_a", revisionId: "rev_a", normalized, blockLimit: 50, maxChars: 2000, cursorKey };

describe("pageNormalizedDocument", () => {
  test("returns a complete small document and valid JSON", () => {
    const page = pageNormalizedDocument(base);
    expect(JSON.parse(page.body)).toEqual(normalized);
    expect(page).toEqual({ body: JSON.stringify(normalized), truncated: false, returnedBlocks: 6, totalBlocks: 6 });
  });

  test.each([
    { blockLimit: 2, maxChars: 2000 },
    { blockLimit: 50, maxChars: 120 },
  ])("reconstructs every block across pages with limit $blockLimit and ceiling $maxChars", ({ blockLimit, maxChars }) => {
    const collected: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = pageNormalizedDocument({ ...base, blockLimit, maxChars, cursor });
      const parsed = JSON.parse(page.body);
      expect(parsed.title).toBe("Guide");
      expect(parsed.metadata).toEqual({ source: "catalog" });
      expect(page.body.length).toBeLessThanOrEqual(maxChars);
      expect(page.returnedBlocks).toBeGreaterThan(0);
      collected.push(...parsed.blocks);
      cursor = page.nextBlockCursor;
      expect(page.truncated).toBe(Boolean(cursor));
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(collected).toEqual(normalized.blocks);
    expect(pages).toBeGreaterThan(1);
  });

  test("selects repeated heading sections in source order without crossing sibling headings", () => {
    const source: NormalizedDocument = {
      metadata: {},
      blocks: [
        { type: "heading", level: 1, text: "  Café  " },
        { type: "paragraph", text: "First" },
        { type: "heading", level: 2, text: "Details" },
        { type: "paragraph", text: "Nested" },
        { type: "heading", level: 1, text: "Other" },
        { type: "paragraph", text: "Exclude" },
        { type: "heading", level: 1, text: "Café" },
        { type: "paragraph", text: "Second" },
      ],
    };
    const page = pageNormalizedDocument({ ...base, normalized: source, headings: [" cafe\u0301 "] });
    expect(JSON.parse(page.body).blocks).toEqual(source.blocks.filter((_, i) => [0, 1, 2, 3, 6, 7].includes(i)));
    expect(page.totalBlocks).toBe(6);
  });

  test.each([
    { headings: ["Care"], indices: [2, 3] },
    { headings: [" missing "], indices: [] },
    { headings: [], indices: [0, 1, 2, 3, 4, 5] },
  ])("selects headings $headings", ({ headings, indices }) => {
    const page = pageNormalizedDocument({ ...base, headings: [...headings] });
    expect(JSON.parse(page.body).blocks).toEqual(indices.map((i) => normalized.blocks[i]));
    expect(page.totalBlocks).toBe(indices.length);
  });

  test("keeps Unicode JSON valid at the exact character boundary", () => {
    const source: NormalizedDocument = { metadata: {}, blocks: [{ type: "paragraph", text: "🪴 café" }] };
    const size = JSON.stringify(source).length;
    expect(pageNormalizedDocument({ ...base, normalized: source, maxChars: size }).body).toBe(JSON.stringify(source));
    expect(() => pageNormalizedDocument({ ...base, normalized: source, maxChars: size - 1 })).toThrow(expect.objectContaining({ code: "DOCUMENT_BLOCK_TOO_LARGE" }));
  });

  test("rejects one unpageable block and an unpageable empty envelope", () => {
    expect(() => pageNormalizedDocument({ ...base, maxChars: 20 })).toThrow(expect.objectContaining({ code: "DOCUMENT_BLOCK_TOO_LARGE" }));
    expect(() => pageNormalizedDocument({ ...base, normalized: { metadata: {}, blocks: [] }, maxChars: 2 })).toThrow(expect.objectContaining({ code: "DOCUMENT_BLOCK_TOO_LARGE" }));
  });

  test.each(["", "!", "e30", "eyJpbmRleCI6LTF9", "@@@"])("rejects malformed cursor %s", (cursor) => {
    expect(() => pageNormalizedDocument({ ...base, cursor })).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });

  test("rejects a mutated cursor", () => {
    const cursor = pageNormalizedDocument({ ...base, blockLimit: 1 }).nextBlockCursor!;
    const replacement = cursor.endsWith("A") ? "B" : "A";
    expect(() => pageNormalizedDocument({ ...base, cursor: cursor.slice(0, -1) + replacement })).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });

  test("rejects rewritten bindings and index even with a recomputed public SHA-256", () => {
    const issued = pageNormalizedDocument({ ...base, blockLimit: 1 }).nextBlockCursor!;
    const payload = JSON.parse(Buffer.from(issued.split(".")[0]!, "base64url").toString("utf8"));
    const rewritten = Buffer.from(JSON.stringify({
      ...payload,
      documentId: "doc_b",
      revisionId: "rev_b",
      index: 2,
    })).toString("base64url");
    const oldPublicDigest = createHash("sha256").update(rewritten).digest("base64url");
    expect(() => pageNormalizedDocument({ ...base, documentId: "doc_b", revisionId: "rev_b", cursor: `${rewritten}.${oldPublicDigest}` }))
      .toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });

  test.each([
    { documentId: "doc_b", revisionId: "rev_a", headings: ["Tools"] },
    { documentId: "doc_a", revisionId: "rev_b", headings: ["Tools"] },
    { documentId: "doc_a", revisionId: "rev_a", headings: ["Paint"] },
  ])("rejects a cursor with changed document, revision, or heading selection", (change) => {
    const cursor = pageNormalizedDocument({ ...base, blockLimit: 1, headings: ["Tools"] }).nextBlockCursor!;
    expect(() => pageNormalizedDocument({ ...base, ...change, headings: change.headings ? [...change.headings] : undefined, cursor })).toThrow(expect.objectContaining({ code: "CURSOR_STALE" }));
  });

  test("round trips an opaque cursor without a storage key", () => {
    const cursor = encodeBlockCursor({ documentId: "doc_a", revisionId: "rev_a", index: 4, headings: ["tools"] }, cursorKey);
    expect(cursor).not.toContain("documents/");
    expect(decodeBlockCursor(cursor, cursorKey)).toEqual({ documentId: "doc_a", revisionId: "rev_a", index: 4, headings: ["tools"] });
    expect(() => decodeBlockCursor(cursor, Buffer.alloc(32, 0x11)))
      .toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });

  test.each([
    { blockLimit: 0, maxChars: 100 },
    { blockLimit: 1.5, maxChars: 100 },
    { blockLimit: 1, maxChars: 0 },
  ])("rejects unsafe numeric limits", ({ blockLimit, maxChars }) => {
    expect(() => pageNormalizedDocument({ ...base, blockLimit, maxChars })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("rejects a non-array heading selection with a stable error", () => {
    expect(() => pageNormalizedDocument({ ...base, headings: null as unknown as string[] }))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
