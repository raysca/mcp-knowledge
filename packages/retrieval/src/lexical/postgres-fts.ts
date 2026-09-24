import postgres from "postgres";
import type { FilterClause, LexicalHit, LexicalIndex } from "@mcp-knowledge/core";
import { logger, placeholders, serializeError } from "@mcp-knowledge/core";
import { extraWhere, parseJson, toPgPlaceholders } from "../where.ts";

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

const FALLBACK_STOP_WORDS = new Set(
  "a an and are as at be by can do for from how i in is it me my of on or please that the this to was we what with you".split(" "),
);

function sanitizeForTsQuery(term: string): { clean: string; isWildcard: boolean } | null {
  const isWildcard = term.endsWith("*") && term.length > 1;
  const raw = (isWildcard ? term.slice(0, -1) : term).replace(/['"&|!():*<>\\]/g, " ").trim();
  if (!raw) return null;
  return { clean: raw, isWildcard };
}

function tokenToTsQuery(term: string): string | null {
  const parsed = sanitizeForTsQuery(term);
  if (!parsed) return null;
  const parts = parsed.clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts
    .map((p, idx) => {
      const isLast = idx === parts.length - 1;
      return `'${p}'${isLast && parsed.isWildcard ? ":*" : ""}`;
    })
    .join(" & ");
}

function fallbackTerms(tokens: string[]): string[] {
  const groups = new Map<string, Set<string>>();
  for (const token of tokens) {
    const key = token
      .normalize("NFKC")
      .toLowerCase()
      .replace(/ς/g, "σ")
      .replace(/\p{Script=Latin}/gu, (letter) => {
        const decomposed = letter.normalize("NFD");
        return /^[a-z][\u0300-\u036f]$/u.test(decomposed) ? decomposed[0]! : letter;
      })
      .match(/[\p{L}\p{N}\p{Co}]+/gu)
      ?.join(" ") ?? "";
    const isWildcard = token.endsWith("*") && token.length > 1;
    if (!key || (!isWildcard && FALLBACK_STOP_WORDS.has(key))) continue;
    const q = tokenToTsQuery(token);
    if (!q) continue;
    const variants = groups.get(key) ?? new Set<string>();
    variants.add(`(${q})`);
    groups.set(key, variants);
  }
  return [...groups.values()]
    .slice(0, MAX_FALLBACK_TERMS)
    .map((variants) => `(${[...variants].join(" | ")})`);
}

export class PostgresLexicalIndex implements LexicalIndex {
  private readonly client: postgres.Sql;

  constructor(url: string | postgres.Sql) {
    this.client = typeof url === "string" ? postgres(url, { max: 10 }) : url;
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  async search(input: {
    query: string;
    collectionIds?: string[];
    documentIds?: string[];
    filters?: FilterClause[];
    limit: number;
  }): Promise<LexicalHit[]> {
    const tokens = queryTokens(input.query);
    const exactQuery = tokens
      .map(tokenToTsQuery)
      .filter(Boolean)
      .map((q) => `(${q})`)
      .join(" & ");
    if (!exactQuery) return [];

    let exact: LexicalHit[] = [];
    try {
      exact = await this.searchPass(input, exactQuery, "exact");
    } catch (error) {
      logger.warn({ event: "lexical_exact_failed", error: serializeError(error) });
      return [];
    }

    if (exact.length >= input.limit) return exact;
    const terms = fallbackTerms(tokens);
    if (terms.length < 2) return exact;

    try {
      const conditions: string[] = [];
      const conditionArgs: unknown[] = [];
      if (terms.length >= 3) {
        conditions.push(
          `(${terms
            .map(
              () =>
                `CASE WHEN (coalesce(d.title_tsv, ''::tsvector) || c.search_tsv) @@ to_tsquery('simple', ?) THEN 1 ELSE 0 END`,
            )
            .join(" + ")}) >= 2`,
        );
        conditionArgs.push(...terms);
      }
      if (exact.length > 0) {
        conditions.push(`c.id NOT IN (${placeholders(exact.length)})`);
        conditionArgs.push(...exact.map((hit) => hit.chunkId));
      }
      const fallback = await this.searchPass(
        { ...input, limit: input.limit - exact.length },
        terms.join(" | "),
        "fallback",
        conditions.length ? ` AND ${conditions.join(" AND ")}` : "",
        conditionArgs,
      );
      return [
        ...exact,
        ...fallback.map((hit, i) => ({
          ...hit,
          lexicalRank: exact.length + i + 1,
        })),
      ];
    } catch (error) {
      logger.warn({ event: "lexical_fallback_failed", error: serializeError(error) });
      return exact;
    }
  }

  private async searchPass(
    input: Parameters<LexicalIndex["search"]>[0],
    tsqueryStr: string,
    lexicalMatchMode: "exact" | "fallback",
    conditions = "",
    conditionArgs: unknown[] = [],
  ): Promise<LexicalHit[]> {
    const extra = extraWhere(input, "postgres");
    const rawSql = `SELECT c.id, c.document_id, c.revision_id, c.content, c.heading_path, c.location, d.title,
      ts_rank('{0.0, 0.1, 0.4, 0.8}', (coalesce(d.title_tsv, ''::tsvector) || c.search_tsv), to_tsquery('simple', ?)) AS rank
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE (coalesce(d.title_tsv, ''::tsvector) || c.search_tsv) @@ to_tsquery('simple', ?)
        AND d.deleted_at IS NULL${extra.sql}${conditions}
      ORDER BY rank DESC, c.id ASC
      LIMIT ?`;

    const args = [tsqueryStr, tsqueryStr, ...extra.args, ...conditionArgs, input.limit];
    const pgSql = toPgPlaceholders(rawSql);
    const rows = await this.client.unsafe(pgSql, args as any[]);

    return rows.map((row, i) => {
      const rank = Number(row.rank);
      const score = Number.isFinite(rank) ? rank : 0;
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
