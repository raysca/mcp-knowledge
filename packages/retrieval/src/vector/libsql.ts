import { createClient, type Client } from "@libsql/client";
import type { EmbeddedChunk, FilterClause, VectorHit, VectorIndex } from "@mcp-knowledge/core";
import { extraWhere } from "../where.ts";

function vectorLiteral(v: number[]): string {
  return JSON.stringify(v);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export class LibsqlVectorIndex implements VectorIndex {
  private readonly client: Client;

  constructor(url: string) {
    this.client = createClient({ url });
  }

  async insert(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.client.batch(
      chunks.map((c) => ({
        sql: "UPDATE document_chunks SET embedding = vector32(?) WHERE id = ?",
        args: [vectorLiteral(c.vector), c.chunkId],
      })),
    );
  }

  async search(input: {
    collectionIds?: string[];
    documentIds?: string[];
    filters?: FilterClause[];
    vector: number[];
    limit: number;
  }): Promise<VectorHit[]> {
    const extra = extraWhere(input);
    const constrained = extra.sql.length > 0;
    // ponytail: vector_top_k cannot take a WHERE, so filtered retrieval is an exact cosine
    // scan of the matching rows (filters inside the candidate query, before LIMIT). Unfiltered
    // path keeps the ANN index. Ceiling: large filtered corpora scan; add a filtered ANN if
    // a real corpus is big enough to feel it.
    const args: unknown[] = [vectorLiteral(input.vector)];
    let sql: string;
    if (constrained) {
      args.push(...extra.args, input.limit);
      sql = `SELECT c.id, c.document_id, c.revision_id, c.content, c.heading_path, c.location, d.title,
        vector_distance_cos(c.embedding, vector32(?)) AS dist
        FROM document_chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.embedding IS NOT NULL AND d.deleted_at IS NULL${extra.sql}
        ORDER BY dist ASC LIMIT ?`;
    } else {
      const k = Math.min(input.limit, 2000);
      args.push("document_chunks_embedding_idx", vectorLiteral(input.vector), k, input.limit);
      sql = `SELECT c.id, c.document_id, c.revision_id, c.content, c.heading_path, c.location, d.title,
        vector_distance_cos(c.embedding, vector32(?)) AS dist
        FROM vector_top_k(?, vector32(?), ?) vt
        JOIN document_chunks c ON c.rowid = vt.id
        JOIN documents d ON d.id = c.document_id
        WHERE d.deleted_at IS NULL
        ORDER BY dist ASC LIMIT ?`;
    }
    const result = await this.client.execute({ sql, args });
    return result.rows.map((row, i) => {
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
    await this.client.execute({
      sql: "UPDATE document_chunks SET embedding = NULL WHERE revision_id = ?",
      args: [revisionId],
    });
  }
}
