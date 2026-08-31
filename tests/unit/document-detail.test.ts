import { describe, expect, test } from "bun:test";
import {
  accumulateChunkPage,
  canReindexDocument,
  documentIdFromPath,
  shouldNavigateInApp,
} from "../../apps/server/src/ui/pages/document-detail.tsx";

describe("document detail routing", () => {
  test("recognizes a document detail path without treating nested API-like paths as pages", () => {
    expect(documentIdFromPath("/documents/doc_123")).toBe("doc_123");
    expect(documentIdFromPath("/documents/doc%20with%20spaces")).toBe("doc with spaces");
    expect(documentIdFromPath("/documents/doc_123/chunks")).toBeNull();
    expect(documentIdFromPath("/documents")).toBeNull();
    expect(documentIdFromPath("/documents/%")).toBeNull();
  });

  test("preserves native browser behavior for modified document-link clicks", () => {
    expect(shouldNavigateInApp({ button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(true);
    expect(shouldNavigateInApp({ button: 0, altKey: false, ctrlKey: false, metaKey: true, shiftKey: false })).toBe(false);
    expect(shouldNavigateInApp({ button: 1, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(false);
  });
});

describe("document detail chunk pagination", () => {
  test("appends the next page and advances its cursor", () => {
    const current = {
      items: [{ id: "chk_1" }],
      nextCursor: "0",
    } as any;

    expect(
      accumulateChunkPage(current, {
        items: [{ id: "chk_2" }, { id: "chk_3" }] as any,
        nextCursor: "2",
      }) as any,
    ).toEqual({
      items: [{ id: "chk_1" }, { id: "chk_2" }, { id: "chk_3" }],
      nextCursor: "2",
    });
  });

  test("clears the cursor when the final page arrives", () => {
    expect(
      accumulateChunkPage(
        { items: [{ id: "chk_1" }], nextCursor: "0" } as any,
        { items: [{ id: "chk_2" }] as any },
      ) as any,
    ).toEqual({ items: [{ id: "chk_1" }, { id: "chk_2" }], nextCursor: null });
  });
});

describe("document detail request lifecycle", () => {
  test("allows reindex only when the document is not already processing", () => {
    expect(canReindexDocument("ready")).toBe(true);
    expect(canReindexDocument("failed")).toBe(true);
    expect(canReindexDocument("pending")).toBe(false);
    expect(canReindexDocument("processing")).toBe(false);
  });
});
