import { describe, expect, test } from "bun:test";
import { collapseSearchHits } from "../../packages/core/src/retrieval/collapse.ts";
import type { SearchHit } from "../../packages/core/src/domain/types.ts";

function hit(documentId: string, chunkId: string, finalRank: number, score: number, headingPath: string[]): SearchHit {
  return {
    documentId,
    chunkId,
    revisionId: `${documentId}-revision`,
    title: `${documentId} title`,
    content: `${chunkId} content`,
    headingPath,
    score,
    ranking: { finalRank, vectorRank: finalRank, fusionScore: score },
    metadata: { source: chunkId },
  };
}

describe("collapseSearchHits", () => {
  test("keeps the best chunk, counts all matches, and deduplicates canonical headings", () => {
    const hits = [
      hit("doc-b", "b-best", 1, 0.9, [" Garden ", "Materials"]),
      hit("doc-a", "a-best", 2, 0.8, ["Garden", "Core Product"]),
      hit("doc-b", "b-second", 3, 0.7, ["garden", "  Materials ", "Soil", " "]),
      hit("doc-b", "b-third", 4, 0.6, ["Soil", "Compost"]),
    ];

    const collapsed = collapseSearchHits(hits, 2);

    expect(collapsed.map((result) => result.documentId)).toEqual(["doc-b", "doc-a"]);
    expect(collapsed[0]).toMatchObject({
      chunkId: "b-best",
      content: "b-best content",
      score: 0.9,
      metadata: { source: "b-best" },
      matchingChunkCount: 3,
      matchedHeadings: ["Garden", "Materials", "Soil", "Compost"],
      ranking: { finalRank: 1, chunkRank: 1, vectorRank: 1, fusionScore: 0.9 },
    });
    expect(collapsed[1]?.ranking).toMatchObject({ finalRank: 2, chunkRank: 2 });
    expect(hits[0]?.headingPath).toEqual([" Garden ", "Materials"]);
  });

  test("uses document id for tied representative ranks and assigns document ranks", () => {
    const hits = [
      hit("doc-z", "z", 1, 0.5, []),
      hit("doc-b", "b", 1, 0.5, []),
      hit("doc-a", "a", 1, 0.5, []),
      hit("doc-c", "c", 2, 0.4, []),
    ];

    expect(collapseSearchHits(hits, 3).map(({ documentId, ranking }) => [documentId, ranking.finalRank, ranking.chunkRank]))
      .toEqual([["doc-a", 1, 1], ["doc-b", 2, 1], ["doc-z", 3, 1]]);
  });

  test("uses score before document id when chunk ranks tie", () => {
    const hits = [hit("doc-a", "a", 1, 0.4, []), hit("doc-z", "z", 1, 0.6, [])];
    expect(collapseSearchHits(hits, 2).map(({ documentId }) => documentId)).toEqual(["doc-z", "doc-a"]);
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe limit %s", (limit) => {
    expect(() => collapseSearchHits([], limit)).toThrow();
  });
});
