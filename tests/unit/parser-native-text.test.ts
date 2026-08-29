import { describe, expect, test } from "bun:test";
import { createParserRegistry } from "../../packages/parser/src/index.ts";

async function parse(filename: string, text: string, mimeType?: string) {
  const registry = createParserRegistry();
  const parser = registry.find({ extension: filename.split(".").pop(), mimeType });
  if (!parser) throw new Error(`no parser for ${filename}`);
  return parser.parse({ data: new Blob([text]), filename, mimeType });
}

describe("native-text parsers", () => {
  test("txt splits on blank lines into paragraphs", async () => {
    const doc = await parse("note.txt", "hello\n\nworld", "text/plain");
    expect(doc.blocks).toEqual([
      { type: "paragraph", text: "hello" },
      { type: "paragraph", text: "world" },
    ]);
  });

  test("markdown emits headings and paragraphs", async () => {
    const doc = await parse("doc.md", "# Title\n\nA paragraph.", "text/markdown");
    expect(doc.blocks).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", text: "A paragraph." },
    ]);
  });

  test("html walks headings and paragraphs", async () => {
    const doc = await parse(
      "page.html",
      "<h1>Title</h1><p>Hello <b>there</b>.</p>",
      "text/html",
    );
    expect(doc.blocks).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "paragraph", text: "Hello there." },
    ]);
  });

  test("json is a single code block", async () => {
    const doc = await parse("data.json", '{"ok":true}', "application/json");
    expect(doc.blocks).toEqual([{ type: "code", text: '{"ok":true}' }]);
  });

  test("xml is a single code block", async () => {
    const doc = await parse("data.xml", "<root/>", "application/xml");
    expect(doc.blocks).toEqual([{ type: "code", text: "<root/>" }]);
  });
});
