import { createClient, type Client } from "@libsql/client";
import type { EmbeddedChunk, VectorHit, VectorIndex } from "@mcp-knowledge/core";

function vectorLiteral(v: number[]): string {
  return JSON.stringify(v);
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
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
    vector: number[];
    limit: number;
  }): Promise<VectorHit[]> {
    // ponytail: was `ORDER BY vector_distance_cos(...) LIMIT` over the whole table - verified
    // with EXPLAIN QUERY PLAN that this is a full "SCAN document_chunks", ignoring the
    // libsql_vector_idx entirely (that index is only used via the vector_top_k() virtual
    // table). vector_top_k has no distance/filter columns of its own, so filters still apply
    // after the ANN lookup, same as before - but now the ANN candidate pool is over-fetched
    // when a filter is present so a narrow document/collection filter doesn't starve on a
    // too-small top-K. A real per-filter candidate pool (spec's VECTOR_CANDIDATES) arrives
    // with M4's hybrid retrieval; this cap is a stopgap, not the final design.
    const hasFilter = Boolean(input.documentIds?.length || input.collectionIds?.length);
    const k = Math.min(hasFilter ? input.limit * 20 : input.limit, 2000);
    // Arg order must match placeholder order left-to-right: the SELECT's distance calc first,
    // then vector_top_k's (idx, vector, k).
    const args: Array<string | number> = [
      vectorLiteral(input.vector),
      "document_chunks_embedding_idx",
      vectorLiteral(input.vector),
      k,
    ];
    let sql = `SELECT c.id, c.document_id, c.revision_id, c.content, c.heading_path, c.location, d.title,
      vector_distance_cos(c.embedding, vector32(?)) AS dist
      FROM vector_top_k(?, vector32(?), ?) vt
      JOIN document_chunks c ON c.rowid = vt.id
      JOIN documents d ON d.id = c.document_id
      WHERE d.deleted_at IS NULL`;
    if (input.documentIds?.length) {
      sql += ` AND c.document_id IN (${placeholders(input.documentIds.length)})`;
      args.push(...input.documentIds);
    }
    if (input.collectionIds?.length) {
      sql += ` AND c.collection_id IN (${placeholders(input.collectionIds.length)})`;
      args.push(...input.collectionIds);
    }
    sql += " ORDER BY dist ASC LIMIT ?";
    args.push(input.limit);
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
