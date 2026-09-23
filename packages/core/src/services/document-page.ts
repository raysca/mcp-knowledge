import { createHmac, timingSafeEqual } from "node:crypto";
import type { DocumentBlock, NormalizedDocument } from "../domain/normalized.ts";
import { AppError } from "../errors.ts";

export type DocumentPageInput = {
  documentId: string;
  revisionId: string;
  normalized: NormalizedDocument;
  cursor?: string;
  blockLimit: number;
  maxChars: number;
  headings?: string[];
  cursorKey: Uint8Array;
};

export type DocumentPageResult = {
  body: string;
  truncated: boolean;
  nextBlockCursor?: string;
  returnedBlocks: number;
  totalBlocks: number;
};

export type BlockCursor = {
  documentId: string;
  revisionId: string;
  index: number;
  headings: string[];
};

function invalidCursor(): never {
  throw new AppError("INVALID_CURSOR", "The block cursor is invalid.");
}

function requireCursorKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new AppError("INVALID_ARGUMENT", "The block cursor key must contain at least 32 bytes.");
  }
}

function normalizedHeading(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en");
}

function headingSelection(headings: string[] | undefined): string[] {
  if (headings === undefined) return [];
  if (!Array.isArray(headings) || headings.some((heading) => typeof heading !== "string")) {
    throw new AppError("INVALID_ARGUMENT", "Headings must be an array of strings.");
  }
  if (headings.length === 0) return [];
  return [...new Set(headings.map(normalizedHeading))].sort();
}

function selectedBlocks(blocks: DocumentBlock[], headings: string[]): DocumentBlock[] {
  if (headings.length === 0) return blocks;
  const wanted = new Set(headings);
  const selected = new Set<number>();
  for (let start = 0; start < blocks.length; start++) {
    const heading = blocks[start];
    if (heading?.type !== "heading" || !wanted.has(normalizedHeading(heading.text))) continue;
    selected.add(start);
    for (let index = start + 1; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (block.type === "heading" && block.level <= heading.level) break;
      selected.add(index);
    }
  }
  return blocks.filter((_, index) => selected.has(index));
}

export function encodeBlockCursor(cursor: BlockCursor, key: Uint8Array): string {
  requireCursorKey(key);
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  const digest = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${digest}`;
}

export function decodeBlockCursor(value: string, key: Uint8Array): BlockCursor {
  requireCursorKey(key);
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
  const [payload, digest] = value.split(".");
  const suppliedMac = Buffer.from(digest!, "base64url");
  const expectedMac = createHmac("sha256", key).update(payload!).digest();
  if (suppliedMac.byteLength !== expectedMac.byteLength ||
      suppliedMac.toString("base64url") !== digest ||
      !timingSafeEqual(suppliedMac, expectedMac)) invalidCursor();
  try {
    const bytes = Buffer.from(payload!, "base64url");
    if (bytes.toString("base64url") !== payload) invalidCursor();
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalidCursor();
    const cursor = parsed as Record<string, unknown>;
    if (
      typeof cursor.documentId !== "string" || !cursor.documentId ||
      typeof cursor.revisionId !== "string" || !cursor.revisionId ||
      !Number.isSafeInteger(cursor.index) || (cursor.index as number) < 0 ||
      !Array.isArray(cursor.headings) ||
      cursor.headings.some((heading) => typeof heading !== "string")
    ) invalidCursor();
    return cursor as BlockCursor;
  } catch {
    return invalidCursor();
  }
}

export function pageNormalizedDocument(input: DocumentPageInput): DocumentPageResult {
  requireCursorKey(input.cursorKey);
  if (!Number.isSafeInteger(input.blockLimit) || input.blockLimit < 1 ||
      !Number.isSafeInteger(input.maxChars) || input.maxChars < 1) {
    throw new AppError("INVALID_ARGUMENT", "Block limit and character ceiling must be positive integers.");
  }
  const headings = headingSelection(input.headings);
  const blocks = selectedBlocks(input.normalized.blocks, headings);
  const cursor = input.cursor === undefined ? undefined : decodeBlockCursor(input.cursor, input.cursorKey);
  if (cursor && (cursor.documentId !== input.documentId || cursor.revisionId !== input.revisionId ||
      JSON.stringify(cursor.headings) !== JSON.stringify(headings))) {
    throw new AppError("CURSOR_STALE", "The block cursor does not match this document revision or heading selection.");
  }
  const start = cursor?.index ?? 0;
  if (start > blocks.length) invalidCursor();

  const pageBlocks: DocumentBlock[] = [];
  let body = JSON.stringify({ ...input.normalized, blocks: pageBlocks });
  if (body.length > input.maxChars) {
    throw new AppError("DOCUMENT_BLOCK_TOO_LARGE", "The document envelope exceeds the character ceiling.");
  }
  for (let index = start; index < blocks.length && pageBlocks.length < input.blockLimit; index++) {
    pageBlocks.push(blocks[index]!);
    const candidate = JSON.stringify({ ...input.normalized, blocks: pageBlocks });
    if (candidate.length > input.maxChars) {
      pageBlocks.pop();
      if (pageBlocks.length === 0) {
        throw new AppError("DOCUMENT_BLOCK_TOO_LARGE", "A document block exceeds the character ceiling.");
      }
      break;
    }
    body = candidate;
  }
  const nextIndex = start + pageBlocks.length;
  const truncated = nextIndex < blocks.length;
  return {
    body,
    truncated,
    ...(truncated ? { nextBlockCursor: encodeBlockCursor({
      documentId: input.documentId,
      revisionId: input.revisionId,
      index: nextIndex,
      headings,
    }, input.cursorKey) } : {}),
    returnedBlocks: pageBlocks.length,
    totalBlocks: blocks.length,
  };
}
