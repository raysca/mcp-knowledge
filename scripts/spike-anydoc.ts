import { toDocument } from "@firecrawl/anydoc";

const path = new URL("./fixtures/hello.docx", import.meta.url);
const bytes = await Bun.file(path).bytes();
const doc = await toDocument(bytes);
const blocks = (doc as { blocks?: unknown[] }).blocks;
if (!blocks?.length) {
  throw new Error("empty anydoc document");
}
console.log("anydoc ok", blocks.length);
