import { AppError } from "../errors.ts";
import type { CollapsedSearchHit, SearchHit } from "../domain/types.ts";

export function collapseSearchHits(hits: SearchHit[], limit: number): CollapsedSearchHit[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AppError("INVALID_ARGUMENT", "Search limit must be a positive integer.");
  }

  const byDocument = new Map<string, { result: CollapsedSearchHit; headings: Set<string> }>();
  for (const hit of hits) {
    let entry = byDocument.get(hit.documentId);
    if (!entry) {
      entry = {
        result: {
          ...hit,
          ranking: { ...hit.ranking, chunkRank: hit.ranking.finalRank },
          matchingChunkCount: 0,
          matchedHeadings: [],
        },
        headings: new Set(),
      };
      byDocument.set(hit.documentId, entry);
    } else if (hit.ranking.finalRank < entry.result.ranking.chunkRank ||
        (hit.ranking.finalRank === entry.result.ranking.chunkRank && hit.chunkId < entry.result.chunkId)) {
      entry.result = {
        ...hit,
        ranking: { ...hit.ranking, chunkRank: hit.ranking.finalRank },
        matchingChunkCount: entry.result.matchingChunkCount,
        matchedHeadings: entry.result.matchedHeadings,
      };
    }
    entry.result.matchingChunkCount += 1;
    for (const rawHeading of hit.headingPath) {
      const heading = rawHeading.trim().replace(/\s+/g, " ");
      const key = heading.toLowerCase();
      if (heading && !entry.headings.has(key)) {
        entry.headings.add(key);
        entry.result.matchedHeadings.push(heading);
      }
    }
  }

  return [...byDocument.values()]
    .map(({ result }) => result)
    .sort((a, b) => a.ranking.chunkRank - b.ranking.chunkRank ||
      (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0))
    .slice(0, limit)
    .map((hit, index) => ({ ...hit, ranking: { ...hit.ranking, finalRank: index + 1 } }));
}
