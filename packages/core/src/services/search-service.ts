import { AppError } from "../errors.ts";
import type { SearchHit } from "../domain/types.ts";
import type { Embedder, LexicalIndex, VectorHit, VectorIndex } from "../ports.ts";
import { parseFilters } from "../retrieval/filters.ts";
import { hybridRrf } from "../retrieval/rrf.ts";
import type { KnowledgeRepository } from "../ports.ts";
import type { StoredChunk } from "../domain/types.ts";

export type SearchExplain = {
  hits: SearchHit[];
  vector: VectorHit[];
  lexical: Awaited<ReturnType<LexicalIndex["search"]>>;
  timings: {
    embeddingMs: number;
    vectorSearchMs: number;
    lexicalSearchMs: number;
    fusionMs: number;
    totalMs: number;
  };
  matchedTerms: string[];
  filters: unknown;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function headingPrefix(a: string[], b: string[]): boolean {
  if (b.length > a.length) return false;
  return b.every((h, i) => a[i] === h);
}

function expandContent(hit: StoredChunk, all: StoredChunk[], expand: { type: string; before: number; after: number }): string {
  if (expand.type === "neighbors") {
    const around = all.filter(
      (c) => c.sequence >= hit.sequence - expand.before && c.sequence <= hit.sequence + expand.after,
    );
    return around.map((c) => c.content).join("\n\n");
  }
  if (expand.type === "section") {
    const section = all.filter((c) => headingPrefix(c.headingPath, hit.headingPath)).slice(0, 40);
    return section.map((c) => c.content).join("\n\n");
  }
  if (expand.type === "document") {
    return all.slice(0, 80).map((c) => c.content).join("\n\n");
  }
  return hit.content;
}

export class SearchService {
  constructor(
    private readonly embedder: Embedder,
    private readonly vectors: VectorIndex,
    private readonly lexical: LexicalIndex,
    private readonly repo: KnowledgeRepository,
    private readonly limits: {
      VECTOR_CANDIDATES: number;
      LEXICAL_CANDIDATES: number;
      RRF_K: number;
    },
  ) {}

  async search(input: {
    query: string;
    collectionIds?: string[];
    documentIds?: string[];
    filters?: unknown;
    mode?: string;
    limit: number;
    expand?: { type?: string; before?: number; after?: number };
    explain?: boolean;
  }): Promise<{ hits: SearchHit[] } | SearchExplain> {
    const query = input.query.trim();
    if (!query) throw new AppError("INVALID_QUERY", "Query must not be empty.", 400);
    const mode = input.mode ?? "hybrid";
    if (mode !== "vector" && mode !== "lexical" && mode !== "hybrid") {
      throw new AppError("SEARCH_MODE_UNSUPPORTED", `Unknown search mode: ${mode}`, 400);
    }
    const filters = parseFilters(input.filters);
    const expand = {
      type: input.expand?.type ?? "none",
      before: clamp(input.expand?.before ?? 2, 0, 5),
      after: clamp(input.expand?.after ?? 2, 0, 5),
    };
    const t0 = performance.now();
    let embeddingMs = 0;
    let vectorSearchMs = 0;
    let lexicalSearchMs = 0;
    let vector: VectorHit[] = [];
    let lexical: Awaited<ReturnType<LexicalIndex["search"]>> = [];

    if (mode === "vector" || mode === "hybrid") {
      const e0 = performance.now();
      const [vec] = await this.embedder.embed([query]);
      embeddingMs = performance.now() - e0;
      if (!vec) throw new AppError("INTERNAL_ERROR", "Embedder returned no vector.", 500);
      const v0 = performance.now();
      vector = await this.vectors.search({
        collectionIds: input.collectionIds,
        documentIds: input.documentIds,
        filters,
        vector: vec,
        limit: mode === "hybrid" ? this.limits.VECTOR_CANDIDATES : input.limit,
      });
      vectorSearchMs = performance.now() - v0;
    }
    if (mode === "lexical" || mode === "hybrid") {
      const l0 = performance.now();
      lexical = await this.lexical.search({
        query,
        collectionIds: input.collectionIds,
        documentIds: input.documentIds,
        filters,
        limit: mode === "hybrid" ? this.limits.LEXICAL_CANDIDATES : input.limit,
      });
      lexicalSearchMs = performance.now() - l0;
    }

    const f0 = performance.now();
    const fused =
      mode === "hybrid"
        ? hybridRrf(vector, lexical, this.limits.RRF_K)
        : mode === "vector"
          ? vector.map((h, i) => ({
              chunkId: h.chunkId,
              fusionScore: h.score,
              vectorRank: i + 1,
              lexicalRank: undefined as number | undefined,
            }))
          : lexical.map((h, i) => ({
              chunkId: h.chunkId,
              fusionScore: h.score,
              vectorRank: undefined as number | undefined,
              lexicalRank: i + 1,
            }));
    const byId = new Map<string, VectorHit | (typeof lexical)[0]>();
    for (const h of vector) byId.set(h.chunkId, h);
    for (const h of lexical) if (!byId.has(h.chunkId)) byId.set(h.chunkId, h);

    const vecById = new Map(vector.map((h) => [h.chunkId, h]));
    const lexById = new Map(lexical.map((h) => [h.chunkId, h]));
    const top = fused.slice(0, input.limit);
    const revCache = new Map<string, StoredChunk[]>();
    const hits: SearchHit[] = [];
    for (const [i, row] of top.entries()) {
      const src = byId.get(row.chunkId);
      if (!src) continue;
      let content = src.content;
      if (expand.type !== "none") {
        let all = revCache.get(src.revisionId);
        if (!all) {
          all = await this.repo.listRevisionChunks(src.revisionId);
          revCache.set(src.revisionId, all);
        }
        const self = all.find((c) => c.id === src.chunkId);
        if (self) content = expandContent(self, all, expand);
      }
      const v = vecById.get(row.chunkId);
      const l = lexById.get(row.chunkId);
      hits.push({
        chunkId: src.chunkId,
        documentId: src.documentId,
        revisionId: src.revisionId,
        title: src.title,
        content,
        headingPath: src.headingPath,
        location: src.location,
        score: mode === "hybrid" ? row.fusionScore : src.score,
        ranking: {
          finalRank: i + 1,
          vectorRank: row.vectorRank ?? v?.vectorRank,
          lexicalRank: row.lexicalRank ?? l?.lexicalRank,
          vectorScore: v?.vectorScore,
          lexicalScore: l?.lexicalScore,
          fusionScore: mode === "hybrid" ? row.fusionScore : undefined,
        },
        metadata: {},
      });
    }
    const fusionMs = performance.now() - f0;
    const totalMs = performance.now() - t0;
    const qTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const blob = lexical.map((h) => h.content.toLowerCase()).join(" ");
    const matchedTerms = qTokens.filter((t) => blob.includes(t.replace(/^"+|"+$/g, "")));
    if (input.explain) {
      return {
        hits,
        vector,
        lexical,
        timings: { embeddingMs, vectorSearchMs, lexicalSearchMs, fusionMs, totalMs },
        matchedTerms,
        filters: input.filters ?? {},
      };
    }
    return { hits };
  }
}
