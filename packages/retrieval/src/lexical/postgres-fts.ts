import postgres from "postgres";
import type { FilterClause, LexicalHit, LexicalIndex } from "@mcp-knowledge/core";
import { extraWhere, parseJson, toPgPlaceholders } from "../where.ts";

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
    const trimmed = input.query.trim();
    if (!trimmed) return [];

    const extra = extraWhere(input, "postgres");
    const rawSql = `SELECT c.id, c.document_id, c.revision_id, c.content, c.heading_path, c.location, d.title,
      ts_rank(c.search_tsv, plainto_tsquery('simple', ?)) AS rank
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.search_tsv @@ plainto_tsquery('simple', ?)
        AND d.deleted_at IS NULL${extra.sql}
      ORDER BY rank DESC
      LIMIT ?`;

    const args = [trimmed, trimmed, ...extra.args, input.limit];
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
      };
    });
  }
}
