import { describe, expect, test } from "bun:test";
import { mapAnyDocError, mapToNormalizedDocument } from "../../packages/parser/src/adapters/anydoc/map.ts";

describe("anydoc map", () => {
  test("maps heading, paragraph, table, list, code, quote, image", () => {
    const doc = mapToNormalizedDocument({
      blocks: [
        { kind: "heading", level: 2, content: [{ kind: "text", text: "Intro" }] },
        { kind: "paragraph", content: [{ kind: "text", text: "Hello" }] },
        { kind: "quote", content: [{ kind: "text", text: "Cited" }] },
        { kind: "list", ordered: true, items: [[{ kind: "text", text: "one" }]] },
        { kind: "table", headers: ["A"], rows: [["1"]] },
        { kind: "code", text: "x = 1" },
        { kind: "image", alt: "chart" },
      ],
    });
    expect(doc.blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "quote",
      "list",
      "table",
      "code",
      "image",
    ]);
  });

  test("maps AnyDoc error codes", () => {
    expect(mapAnyDocError("needsOcr").code).toBe("DOCUMENT_NEEDS_OCR");
    expect(mapAnyDocError("encrypted").code).toBe("DOCUMENT_ENCRYPTED");
    expect(mapAnyDocError("unsupported").code).toBe("DOCUMENT_UNSUPPORTED_FORMAT");
    expect(mapAnyDocError("resourceLimit").code).toBe("DOCUMENT_RESOURCE_LIMIT");
    expect(mapAnyDocError("malformed").code).toBe("DOCUMENT_MALFORMED");
    expect(mapAnyDocError("missingPart").code).toBe("DOCUMENT_MALFORMED");
  });
});
