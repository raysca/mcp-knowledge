import { extname } from "node:path";
import type { DocumentBlock, DocumentParser, NormalizedDocument } from "@mcp-knowledge/core";

export const NATIVE_TEXT_EXTS = new Set(["txt", "md", "markdown", "html", "htm", "json", "xml"]);

function extOf(filename: string): string | undefined {
  const ext = extname(filename).slice(1).toLowerCase();
  return ext || undefined;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function parseTxt(text: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let paragraphStart = 0;
  const addParagraph = (raw: string, start: number) => {
    const first = raw.search(/\S/);
    if (first === -1) return;
    const value = raw.trim();
    const charStart = start + first;
    blocks.push({
      type: "paragraph",
      text: value,
      location: { charStart, charEnd: charStart + value.length },
    });
  };
  for (const separator of text.matchAll(/\n\s*\n/g)) {
    addParagraph(text.slice(paragraphStart, separator.index), paragraphStart);
    paragraphStart = separator.index! + separator[0].length;
  }
  addParagraph(text.slice(paragraphStart), paragraphStart);
  return blocks;
}

export function parseMarkdown(text: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }
    if (!line.trim()) continue;
    const last = blocks[blocks.length - 1];
    if (last?.type === "paragraph") last.text += ` ${line.trim()}`;
    else blocks.push({ type: "paragraph", text: line.trim() });
  }
  return blocks;
}

function parseHtml(text: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>|<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  for (const m of text.matchAll(re)) {
    if (m[1]) {
      blocks.push({ type: "heading", level: Number(m[1]), text: stripTags(m[2] ?? "") });
    } else {
      blocks.push({ type: "paragraph", text: stripTags(m[3] ?? "") });
    }
  }
  return blocks;
}

export class NativeTextParser implements DocumentParser {
  name = "native-text";
  version = "2";

  supports(input: { mimeType?: string; extension?: string }): boolean {
    const ext = input.extension?.toLowerCase();
    if (ext && NATIVE_TEXT_EXTS.has(ext)) return true;
    const mime = input.mimeType ?? "";
    return (
      mime === "text/plain" ||
      mime === "text/markdown" ||
      mime === "text/html" ||
      mime === "application/json" ||
      mime === "application/xml" ||
      mime === "text/xml"
    );
  }

  async parse(input: {
    data: Blob;
    filename: string;
    mimeType?: string;
    signal?: AbortSignal;
  }): Promise<NormalizedDocument> {
    input.signal?.throwIfAborted();
    const text = await input.data.text();
    input.signal?.throwIfAborted();
    const ext = extOf(input.filename);
    let blocks: DocumentBlock[];
    if (ext === "html" || ext === "htm" || input.mimeType === "text/html") {
      blocks = parseHtml(text);
    } else if (ext === "md" || ext === "markdown" || input.mimeType === "text/markdown") {
      blocks = parseMarkdown(text);
    } else if (ext === "json" || input.mimeType === "application/json") {
      blocks = [{ type: "code", text, location: { charStart: 0, charEnd: text.length } }];
    } else if (ext === "xml" || input.mimeType === "application/xml" || input.mimeType === "text/xml") {
      blocks = [{ type: "code", text, location: { charStart: 0, charEnd: text.length } }];
    } else {
      blocks = parseTxt(text);
    }
    return { metadata: {}, blocks };
  }
}
