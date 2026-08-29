import { AppError } from "../errors.ts";
import type { SearchHit } from "../domain/types.ts";
import type { Embedder, VectorIndex } from "../ports.ts";

export class SearchService {
  constructor(
    private readonly embedder: Embedder,
    private readonly vectors: VectorIndex,
  ) {}

  async search(input: {
    query: string;
    collectionIds?: string[];
    documentIds?: string[];
    mode?: string;
    limit: number;
  }): Promise<{ hits: SearchHit[] }> {
    const query = input.query.trim();
    if (!query) throw new AppError("INVALID_QUERY", "Query must not be empty.", 400);
    const mode = input.mode ?? "vector";
    if (mode !== "vector") {
      throw new AppError(
        "SEARCH_MODE_UNSUPPORTED",
        "Only mode=vector is available until hybrid retrieval ships.",
        400,
      );
    }
    const [vector] = await this.embedder.embed([query]);
    if (!vector) throw new AppError("INTERNAL_ERROR", "Embedder returned no vector.", 500);
    const raw = await this.vectors.search({
      collectionIds: input.collectionIds,
      documentIds: input.documentIds,
      vector,
      limit: input.limit,
    });
    return {
      hits: raw.map((h, i) => ({
        chunkId: h.chunkId,
        documentId: h.documentId,
        revisionId: h.revisionId,
        title: h.title,
        content: h.content,
        headingPath: h.headingPath,
        location: h.location,
        score: h.score,
        ranking: {
          finalRank: i + 1,
          vectorRank: h.vectorRank,
          vectorScore: h.vectorScore,
        },
        metadata: {},
      })),
    };
  }
}
