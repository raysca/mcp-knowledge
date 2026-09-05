import type { DocumentBlock, SourceLocation } from "../domain/normalized.ts";

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
  location?: Record<string, unknown>;
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

// ponytail: binary search, not a linear word-by-word decrement. countTokens runs the real
// WordPiece tokenizer, and shrinking one word at a time re-tokenizes the whole remaining text
// on every step — O(n^2) tokenizer calls over a block's word count. A single large block (an
// entire JSON/XML/TXT file can land in one block, up to MAX_EXTRACT_BYTES) made this run long
// enough to block the event loop past INGESTION_TIMEOUT_MS's ability to even fire — timers
// can't run while a synchronous loop is still executing. Binary search is O(log n) calls.
function longestPrefixWithinBudget(words: string[], max: number, countTokens: CountTokens): number {
  let lo = 1;
  let hi = words.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokens(words.slice(0, mid).join(" ")) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function fitPrefix(text: string, max: number, countTokens: CountTokens): { head: string; rest: string } {
  const words = wordsOf(text);
  if (words.length === 0) return { head: "", rest: "" };
  if (countTokens(text) <= max) return { head: text, rest: "" };
  const n = longestPrefixWithinBudget(words, max, countTokens);
  return { head: words.slice(0, n).join(" "), rest: words.slice(n).join(" ") };
}

function lastWords(text: string, n: number): string {
  return wordsOf(text).slice(-n).join(" ");
}

type ChunkPiece = { headingPath: string[]; text: string; location?: SourceLocation };

function mergedLocation(a?: SourceLocation, b?: SourceLocation): SourceLocation | undefined {
  if (!a || !b) return undefined;
  const aStart = a.charStart;
  const aEnd = a.charEnd;
  const bStart = b.charStart;
  const bEnd = b.charEnd;
  if (
    !Number.isInteger(aStart) ||
    !Number.isInteger(aEnd) ||
    !Number.isInteger(bStart) ||
    !Number.isInteger(bEnd)
  ) {
    return undefined;
  }
  return { charStart: Math.min(aStart!, bStart!), charEnd: Math.max(aEnd!, bEnd!) };
}

function flatten(blocks: DocumentBlock[]): ChunkPiece[] {
  const path: string[] = [];
  const units: ChunkPiece[] = [];
  for (const block of blocks) {
    if (block.type === "heading") {
      path.length = Math.max(0, block.level - 1);
      path[block.level - 1] = block.text;
      continue;
    }
    const text = blockText(block).trim();
    if (!text) continue;
    units.push({ headingPath: path.filter((p) => p).slice(), text, location: block.location });
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
  const bodyWords = wordsOf(content);
  if (bodyWords.length === 0 || countTokens(prefix + content) <= EMBEDDING_MAX_TOKENS) {
    return prefix + content;
  }
  const budget = (n: number) => countTokens(`${prefix}${bodyWords.slice(0, n).join(" ")}`);
  let lo = 0;
  let hi = bodyWords.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (budget(mid) <= EMBEDDING_MAX_TOKENS) lo = mid;
    else hi = mid - 1;
  }
  return prefix + bodyWords.slice(0, lo).join(" ");
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
  const pieces: ChunkPiece[] = [];
  for (const unit of flatten(blocks)) {
    let rest = unit.text;
    while (rest) {
      const { head, rest: next } = fitPrefix(rest, CHUNK_MAX, countTokens);
      if (!head) break;
      pieces.push({ headingPath: unit.headingPath, text: head, location: unit.location });
      rest = next;
    }
  }

  const packed: ChunkPiece[] = [];
  let current: ChunkPiece | undefined;
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
      current.location = mergedLocation(current.location, piece.location);
      continue;
    }
    if (samePath && n <= CHUNK_MAX && countTokens(current.text) < CHUNK_TARGET) {
      current.text = combined;
      current.location = mergedLocation(current.location, piece.location);
      continue;
    }
    packed.push(current);
    const overlap = lastWords(current.text, CHUNK_OVERLAP);
    current = {
      headingPath: piece.headingPath,
      text: overlap && samePath ? `${overlap} ${piece.text}` : piece.text,
      location: overlap && samePath ? mergedLocation(current.location, piece.location) : piece.location,
    };
  }
  if (current) packed.push(current);

  // Merge any chunk under CHUNK_MIN into its same-heading-path predecessor, not just a
  // last-chunk special case — a short section anywhere in the document (a FAQ's one-line
  // answer, a stray paragraph right before a new heading) produced an under-minimum chunk
  // that nothing ever picked back up unless it happened to land last.
  const sized: ChunkPiece[] = [];
  for (const piece of packed) {
    const prevPiece = sized[sized.length - 1];
    const samePath = prevPiece && prevPiece.headingPath.join("\0") === piece.headingPath.join("\0");
    const eitherUndersized =
      prevPiece && (countTokens(prevPiece.text) < CHUNK_MIN || countTokens(piece.text) < CHUNK_MIN);
    if (samePath && prevPiece && eitherUndersized) {
      const merged = `${prevPiece.text} ${piece.text}`;
      if (countTokens(merged) <= CHUNK_MAX) {
        prevPiece.text = merged;
        prevPiece.location = mergedLocation(prevPiece.location, piece.location);
        continue;
      }
    }
    sized.push({ ...piece });
  }

  return sized.map((p, sequence) => {
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
      location: p.location,
      tokenCount: countTokens(content),
      contentHash: hasher.digest("hex"),
    };
  });
}
