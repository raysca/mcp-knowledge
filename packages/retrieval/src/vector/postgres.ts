import postgres from "postgres";
import type { EmbeddedChunk, FilterClause, VectorHit, VectorIndex } from "@mcp-knowledge/core";
import { extraWhere, parseJson, toPgPlaceholders } from "../where.ts";

function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export class PgVectorIndex implements VectorIndex {
  private readonly client: postgres.Sql;

  constructor(url: string | postgres.Sql) {
    this.client = typeof url === "string" ? postgres(url, { max: 10 }) : url;
  }

  async close(): Promise<void> {
    await this.client.end();
  }

  async insert(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const ids: string[] = [];
    const vectors: string[] = [];
    for (const chunk of chunks) {
      ids.push(chunk.chunkId);
      vectors.push(vectorLiteral(chunk.vector));
    }
    await this.client`
      UPDATE document_chunks AS c
      SET embedding = v.vec::vector
      FROM (
        SELECT unnest(${ids}::text[]) AS id,
               unnest(${vectors}::text[]) AS vec
      ) AS v
      WHERE c.id = v.id
        AND EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = c.document_id AND d.deleted_at IS NULL
        )
    `;
  }

  async search(input: {
    collectionIds?: string[];
    documentIds?: string[];
    filters?: FilterClause[];
    vector: number[];
    limit: number;
  }): Promise<VectorHit[]> {
    const extra = extraWhere(input, "postgres");
    const vecStr = vectorLiteral(input.vector);
    const rawSql = `SELECT c.id, c.document_id, c.revision_id, c.content, c.heading_path, c.location, d.title,
      (c.embedding <=> ?::vector) AS dist
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL AND d.deleted_at IS NULL${extra.sql}
      ORDER BY dist ASC, c.id ASC LIMIT ?`;

    const args = [vecStr, ...extra.args, input.limit];
    const pgSql = toPgPlaceholders(rawSql);
    const rows = await this.client.unsafe(pgSql, args as any[]);

    return rows.map((row, i) => {
      const dist = Number(row.dist);
      const score = 1 - dist;
      return {
        chunkId: String(row.id),
        documentId: String(row.document_id),
        revisionId: String(row.revision_id),
        title: row.title == null ? undefined : String(row.title),
        content: String(row.content),
        headingPath: parseJson(row.heading_path, [] as string[]),
        location: parseJson<Record<string, unknown> | undefined>(row.location, undefined),
        score,
        vectorRank: i + 1,
        vectorScore: score,
      };
    });
  }

  async deleteRevision(revisionId: string): Promise<void> {
    await this.client`UPDATE document_chunks SET embedding = NULL WHERE revision_id = ${revisionId}`;
  }
}
