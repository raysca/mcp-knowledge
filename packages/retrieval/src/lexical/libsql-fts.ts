import { createClient, type Client, type InValue } from "@libsql/client";
import type { FilterClause, LexicalHit, LexicalIndex } from "@mcp-knowledge/core";
import { extraWhere, parseJson } from "../where.ts";

export function ftsMatchQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(" AND ");
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
    const match = ftsMatchQuery(input.query);
    if (!match) return [];
    const extra = extraWhere(input);
    // See vector/libsql.ts - extra.args is validated as scalars by parseFilters upstream.
    const args: InValue[] = [match, ...(extra.args as InValue[]), input.limit];
    const sql = `SELECT c.id, c.document_id, c.revision_id, c.content, c.heading_path, c.location, d.title, rank
      FROM document_chunks_fts
      JOIN document_chunks c ON c.id = document_chunks_fts.chunk_id
      JOIN documents d ON d.id = c.document_id
      WHERE document_chunks_fts MATCH ?
        AND d.deleted_at IS NULL${extra.sql}
      ORDER BY rank
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
      };
    });
  }
}
