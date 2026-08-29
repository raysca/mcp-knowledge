import type { DocumentBlock } from "../domain/normalized.ts";

export const CHUNK_TARGET = 180;
export const CHUNK_MIN = 64;
export const CHUNK_MAX = 220;
export const CHUNK_OVERLAP = 32;
export const EMBEDDING_MAX_TOKENS = 256;

export type ChunkDraft = {
  id: string;
  sequence: number;
  content: string;
  embeddingText: string;
  headingPath: string[];
  tokenCount: number;
  contentHash: string;
};

export type CountTokens = (text: string) => number;

function blockText(block: DocumentBlock): string {
  switch (block.type) {
    case "heading":
    case "pageBreak":
      return "";
    case "paragraph":
    case "quote":
    case "code":
      return block.text;
    case "list":
      return block.items.join("\n");
    case "table": {
      const header = block.headers?.join("\t");
      const rows = block.rows.map((r) => r.join("\t"));
      return [header, ...rows].filter(Boolean).join("\n");
    }
    case "image":
      return block.alt;
  }
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function fitPrefix(text: string, max: number, countTokens: CountTokens): { head: string; rest: string } {
  const words = wordsOf(text);
  if (words.length === 0) return { head: "", rest: "" };
  if (countTokens(text) <= max) return { head: text, rest: "" };
  let n = words.length;
  while (n > 1 && countTokens(words.slice(0, n).join(" ")) > max) n--;
  return { head: words.slice(0, n).join(" "), rest: words.slice(n).join(" ") };
}

function lastWords(text: string, n: number): string {
  return wordsOf(text).slice(-n).join(" ");
}

function flatten(blocks: DocumentBlock[]): { headingPath: string[]; text: string }[] {
  const path: string[] = [];
  const units: { headingPath: string[]; text: string }[] = [];
  for (const block of blocks) {
    if (block.type === "heading") {
      path.length = Math.max(0, block.level - 1);
      path[block.level - 1] = block.text;
      continue;
    }
    const text = blockText(block).trim();
    if (!text) continue;
    units.push({ headingPath: path.filter((p) => p).slice(), text });
  }
  return units;
}

function makeEmbeddingText(
  title: string,
  headingPath: string[],
  content: string,
  countTokens: CountTokens,
): string {
  const section = headingPath.join(" > ");
  const prefix = `Document: ${title}\nSection: ${section}\n\n`;
  let body = content;
  const bodyWords = wordsOf(body);
  while (bodyWords.length > 0 && countTokens(prefix + body) > EMBEDDING_MAX_TOKENS) {
    bodyWords.pop();
    body = bodyWords.join(" ");
  }
  return prefix + body;
}

function chunkId(revisionHash: string, headingPath: string[], content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${revisionHash}\0${headingPath.join("\0")}\0${content}`);
  return `chk_${hasher.digest("hex").slice(0, 32)}`;
}

export function chunkBlocks(
  blocks: DocumentBlock[],
  input: { title: string; revisionHash: string; countTokens: CountTokens },
): ChunkDraft[] {
  const { title, revisionHash, countTokens } = input;
  const pieces: { headingPath: string[]; text: string }[] = [];
  for (const unit of flatten(blocks)) {
    let rest = unit.text;
    while (rest) {
      const { head, rest: next } = fitPrefix(rest, CHUNK_MAX, countTokens);
      if (!head) break;
      pieces.push({ headingPath: unit.headingPath, text: head });
      rest = next;
    }
  }

  const packed: { headingPath: string[]; text: string }[] = [];
  let current: { headingPath: string[]; text: string } | undefined;
  for (const piece of pieces) {
    if (!current) {
      current = { ...piece };
      continue;
    }
    const samePath = current.headingPath.join("\0") === piece.headingPath.join("\0");
    const combined = `${current.text} ${piece.text}`;
    const n = countTokens(combined);
    if (samePath && n <= CHUNK_TARGET) {
      current.text = combined;
      continue;
    }
    if (samePath && n <= CHUNK_MAX && countTokens(current.text) < CHUNK_TARGET) {
      current.text = combined;
      continue;
    }
    packed.push(current);
    const overlap = lastWords(current.text, CHUNK_OVERLAP);
    current = {
      headingPath: piece.headingPath,
      text: overlap && samePath ? `${overlap} ${piece.text}` : piece.text,
    };
  }
  if (current) packed.push(current);

  const last = packed[packed.length - 1];
  const prev = packed[packed.length - 2];
  if (last && prev && countTokens(last.text) < CHUNK_MIN) {
    const merged = `${prev.text} ${last.text}`;
    if (countTokens(merged) <= CHUNK_MAX) {
      prev.text = merged;
      packed.pop();
    }
  }

  return packed.map((p, sequence) => {
    const content = p.text;
    const embeddingText = makeEmbeddingText(title, p.headingPath, content, countTokens);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(content);
    return {
      id: chunkId(revisionHash, p.headingPath, content),
      sequence,
      content,
      embeddingText,
      headingPath: p.headingPath,
      tokenCount: countTokens(content),
      contentHash: hasher.digest("hex"),
    };
  });
}
