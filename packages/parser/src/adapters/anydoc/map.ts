import { ParserError } from "../../errors.ts";
import type { DocumentBlock, NormalizedDocument } from "@mcp-knowledge/core";

type AnyDocNode = Record<string, unknown>;

function asRecord(value: unknown): AnyDocNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyDocNode)
    : undefined;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  const rec = asRecord(value);
  if (!rec) return "";
  if (typeof rec.text === "string") return rec.text;
  if (rec.content !== undefined) return textOf(rec.content);
  return "";
}

function listItems(block: AnyDocNode): string[] {
  const items = block.items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => textOf(item).trim()).filter(Boolean);
}

function tableRows(block: AnyDocNode): { headers?: string[]; rows: string[][] } {
  const headers = Array.isArray(block.headers)
    ? block.headers.map((h) => textOf(h))
    : undefined;
  const rows = Array.isArray(block.rows)
    ? block.rows.map((row) =>
        Array.isArray(row) ? row.map((cell) => textOf(cell)) : [textOf(row)],
      )
    : [];
  return { headers, rows };
}

export function mapToNormalizedDocument(raw: { blocks?: unknown[] }): NormalizedDocument {
  const blocks: DocumentBlock[] = [];
  for (const item of raw.blocks ?? []) {
    const block = asRecord(item);
    if (!block) continue;
    const kind = String(block.kind ?? block.type ?? "");
    if (kind === "heading") {
      blocks.push({
        type: "heading",
        level: Number(block.level ?? 1),
        text: textOf(block).trim() || textOf(block.content).trim(),
      });
    } else if (kind === "paragraph") {
      blocks.push({ type: "paragraph", text: textOf(block.content ?? block).trim() });
    } else if (kind === "quote") {
      blocks.push({ type: "quote", text: textOf(block.content ?? block).trim() });
    } else if (kind === "list") {
      blocks.push({
        type: "list",
        ordered: Boolean(block.ordered),
        items: listItems(block),
      });
    } else if (kind === "table") {
      const table = tableRows(block);
      blocks.push({ type: "table", headers: table.headers, rows: table.rows });
    } else if (kind === "code") {
      blocks.push({
        type: "code",
        text: typeof block.text === "string" ? block.text : textOf(block),
      });
    } else if (kind === "image") {
      blocks.push({ type: "image", alt: String(block.alt ?? textOf(block) ?? "") });
    } else if (kind === "pageBreak" || kind === "page_break") {
      blocks.push({ type: "pageBreak" });
    } else {
      const text = textOf(block.content ?? block).trim();
      if (text) blocks.push({ type: "paragraph", text });
    }
  }
  return { metadata: {}, blocks };
}

export function mapAnyDocError(code: string, message?: string): ParserError {
  const mapped =
    code === "needsOcr"
      ? "DOCUMENT_NEEDS_OCR"
      : code === "encrypted"
        ? "DOCUMENT_ENCRYPTED"
        : code === "unsupported"
          ? "DOCUMENT_UNSUPPORTED_FORMAT"
          : code === "resourceLimit"
            ? "DOCUMENT_RESOURCE_LIMIT"
            : "DOCUMENT_MALFORMED";
  return new ParserError(mapped, message ?? code);
}
