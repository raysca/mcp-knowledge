import { Format, formatFromBytes, toDocument, toMarkdownBytes } from "@firecrawl/anydoc";
import type { NormalizedDocument } from "@mcp-knowledge/core";
import { mapToNormalizedDocument } from "../adapters/anydoc/map.ts";
import { parseMarkdown } from "../adapters/native-text.ts";

// ponytail: PDF is not a mapper bug, it's structural — anydoc's toDocument() rejects every
// PDF with code "unsupported" (pdf-inspector only emits Markdown for PDF; verified against
// @firecrawl/anydoc@0.2.4). Sniffing the format ourselves and routing PDF through
// toMarkdownBytes + the existing markdown parser is the documented path, not a workaround.
export async function convertToNormalizedDocument(bytes: Uint8Array): Promise<NormalizedDocument> {
  if (formatFromBytes(bytes) === Format.pdf) {
    const markdown = await toMarkdownBytes(bytes, Format.pdf);
    return { metadata: {}, blocks: parseMarkdown(markdown) };
  }
  const doc = await toDocument(bytes);
  return mapToNormalizedDocument(doc as { blocks?: unknown[] });
}
