import type { DocumentBlock, DocumentParser, NormalizedDocument } from "@mcp-knowledge/core";

const EXTS = new Set(["txt", "md", "markdown", "html", "htm", "json", "xml"]);

function extOf(filename: string): string | undefined {
  const i = filename.lastIndexOf(".");
  if (i <= 0) return undefined;
  return filename.slice(i + 1).toLowerCase();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function parseTxt(text: string): DocumentBlock[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((t) => ({ type: "paragraph" as const, text: t }));
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
  version = "1";

  supports(input: { mimeType?: string; extension?: string }): boolean {
    const ext = input.extension?.toLowerCase();
    if (ext && EXTS.has(ext)) return true;
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
  }): Promise<NormalizedDocument> {
    const text = await input.data.text();
    const ext = extOf(input.filename);
    let blocks: DocumentBlock[];
    if (ext === "html" || ext === "htm" || input.mimeType === "text/html") {
      blocks = parseHtml(text);
    } else if (ext === "md" || ext === "markdown" || input.mimeType === "text/markdown") {
      blocks = parseMarkdown(text);
    } else if (ext === "json" || input.mimeType === "application/json") {
      blocks = [{ type: "code", text }];
    } else if (ext === "xml" || input.mimeType === "application/xml" || input.mimeType === "text/xml") {
      blocks = [{ type: "code", text }];
    } else {
      blocks = parseTxt(text);
    }
    return { metadata: {}, blocks };
  }
}
