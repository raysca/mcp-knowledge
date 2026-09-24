import { createClient, type Client, type InValue } from "@libsql/client";
import type { FilterClause, LexicalHit, LexicalIndex } from "@mcp-knowledge/core";
import { logger, placeholders, serializeError } from "@mcp-knowledge/core";
import { extraWhere, parseJson } from "../where.ts";

const MAX_EXACT_TOKENS = 50;
const MAX_FALLBACK_TERMS = 12;

function queryTokens(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean)
    .slice(0, MAX_EXACT_TOKENS);
}

// Deliberately small, static English stop-word set. Only the optional fallback
// uses it; exact matching keeps every original token, including identifiers.
const FALLBACK_STOP_WORDS = new Set(
  "a an and are as at be by can do for from how i in is it me my of on or please that the this to was we what with you".split(" "),
);

const quoted = (term: string) => `"${term}"`;

function fallbackTerms(tokens: string[]): string[] {
  const groups = new Map<string, Set<string>>();
  for (const token of tokens) {
    // Identity only: canonical/compatibility variants and identifier punctuation
    // count once. NFKC folds micro-sign/mu and long-s/s; sigma also needs its final
    // form folded. Keep Greek accents and multi-diacritic Latin characters (ộ).
    const key = token.normalize("NFKC").toLowerCase().replace(/ς/g, "σ")
      .replace(/\p{Script=Latin}/gu, (letter) => {
        const decomposed = letter.normalize("NFD");
        return /^[a-z][\u0300-\u036f]$/u.test(decomposed) ? decomposed[0]! : letter;
      }).match(/[\p{L}\p{N}\p{Co}]+/gu)?.join(" ") ?? "";
    if (!key || FALLBACK_STOP_WORDS.has(key)) continue;
    const variants = groups.get(key) ?? new Set<string>();
    // Never normalize the searchable spelling: even canonical equivalents can
    // tokenize differently. An OR group retains them all but contributes one match.
    variants.add(quoted(token));
    groups.set(key, variants);
  }
  return [...groups.values()]
    .slice(0, MAX_FALLBACK_TERMS)
    .map((variants) => `(${[...variants].join(" OR ")})`);
}

export class LibsqlLexicalIndex implements LexicalIndex {
  private readonly client: Client;

  constructor(url: string) {
    this.client = createClient({ url });
  }

  async search(input: {
    query: string;
    collectionIds?: string[];
    documentIds?: string[];
    filters?: FilterClause[];
    limit: number;
  }): Promise<LexicalHit[]> {
    const tokens = queryTokens(input.query);
    const match = tokens.map(quoted).join(" AND ");
    if (!match) return [];
    const exact = await this.searchPass(input, match, "exact");
    if (exact.length >= input.limit) return exact;
    const terms = fallbackTerms(tokens);
    if (terms.length < 2) return exact;

    try {
      const conditions: string[] = [];
      const args: InValue[] = [];
      if (terms.length >= 3) {
        // Count distinct query-term matches in FTS itself (across all indexed
        // columns), before ORDER BY/LIMIT. Repetition in a chunk counts only once.
        conditions.push(`(${terms.map(() => `CASE WHEN document_chunks_fts.rowid IN
          (SELECT rowid FROM document_chunks_fts WHERE document_chunks_fts MATCH ?)
          THEN 1 ELSE 0 END`).join(" + ")}) >= 2`);
        args.push(...terms);
      }
      if (exact.length) {
        conditions.push(`c.id NOT IN (${placeholders(exact.length)})`);
        args.push(...exact.map((hit) => hit.chunkId));
      }
      const fallback = await this.searchPass(
        { ...input, limit: input.limit - exact.length }, terms.join(" OR "), "fallback",
        conditions.length ? ` AND ${conditions.join(" AND ")}` : "", args,
      );
      return [...exact, ...fallback.map((hit, i) => ({ ...hit, lexicalRank: exact.length + i + 1 }))];
    } catch (error) {
      logger.warn({ event: "lexical_fallback_failed", error: serializeError(error) });
      return exact;
    }
  }

  private async searchPass(
    input: Parameters<LexicalIndex["search"]>[0], match: string,
    lexicalMatchMode: "exact" | "fallback", conditions = "", conditionArgs: InValue[] = [],
  ): Promise<LexicalHit[]> {
    const extra = extraWhere(input);
    // See vector/libsql.ts - extra.args is validated as scalars by parseFilters upstream.
    const args: InValue[] = [match, ...(extra.args as InValue[]), ...conditionArgs, input.limit];
    const sql = `SELECT c.id, c.document_id, c.revision_id, c.content, c.heading_path, c.location, d.title,
        bm25(document_chunks_fts, 0.0, 8.0, 4.0, 1.0) AS rank
      FROM document_chunks_fts
      JOIN document_chunks c ON c.id = document_chunks_fts.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE document_chunks_fts MATCH ?
        AND d.deleted_at IS NULL${extra.sql}${conditions}
      ORDER BY rank, c.id
      LIMIT ?`;
    const result = await this.client.execute({ sql, args });
    return result.rows.map((row, i) => {
      const rank = Number(row.rank);
      const score = Number.isFinite(rank) ? -rank : 0;
      return {
        chunkId: String(row.id),
        documentId: String(row.document_id),
        revisionId: String(row.revision_id),
        title: row.title == null ? undefined : String(row.title),
        content: String(row.content),
        headingPath: parseJson(row.heading_path, [] as string[]),
        location: parseJson<Record<string, unknown> | undefined>(row.location, undefined),
        score,
        lexicalRank: i + 1,
        lexicalScore: score,
        lexicalMatchMode,
      };
    });
  }
}
