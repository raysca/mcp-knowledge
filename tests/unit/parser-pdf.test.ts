import { describe, expect, test } from "bun:test";
import { convertToNormalizedDocument } from "../../packages/parser/src/anydoc/convert.ts";

describe("anydoc PDF routing", () => {
  // Regression: @firecrawl/anydoc's toDocument() rejects every PDF with code "unsupported"
  // (pdf-inspector only emits Markdown for PDF) — every PDF upload failed as
  // DOCUMENT_UNSUPPORTED_FORMAT before convertToNormalizedDocument routed PDF through
  // toMarkdownBytes instead. This fixture has no real text layer, so it still fails --
  // but as "needsOcr", which only toMarkdownBytes can raise. Getting "needsOcr" instead of
  // "unsupported" proves the PDF branch was taken, not skipped.
  test("routes PDF through toMarkdownBytes, not toDocument", async () => {
    const bytes = await Bun.file(
      new URL("../../scripts/fixtures/minimal.pdf", import.meta.url),
    ).bytes();
    await expect(convertToNormalizedDocument(bytes)).rejects.toMatchObject({ code: "needsOcr" });
  });

  test("non-PDF formats still go through toDocument", async () => {
    const bytes = await Bun.file(
      new URL("../../scripts/fixtures/hello.docx", import.meta.url),
    ).bytes();
    const doc = await convertToNormalizedDocument(bytes);
    expect(doc.blocks.length).toBeGreaterThan(0);
  });
});
