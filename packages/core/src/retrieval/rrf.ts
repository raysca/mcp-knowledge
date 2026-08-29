export function rrf(ranks: number[], k = 60): number {
  return ranks.reduce((sum, r) => sum + 1 / (k + r), 0);
}

export type FusedRank = {
  chunkId: string;
  fusionScore: number;
  vectorRank?: number;
  lexicalRank?: number;
};

export function hybridRrf(
  vector: { chunkId: string }[],
  lexical: { chunkId: string }[],
  k = 60,
): FusedRank[] {
  const vectorRank = new Map(vector.map((h, i) => [h.chunkId, i + 1]));
  const lexicalRank = new Map(lexical.map((h, i) => [h.chunkId, i + 1]));
  const fused: FusedRank[] = [];
  for (const chunkId of new Set([...vectorRank.keys(), ...lexicalRank.keys()])) {
    const vr = vectorRank.get(chunkId);
    const lr = lexicalRank.get(chunkId);
    const ranks = [vr, lr].filter((n): n is number => n != null);
    fused.push({ chunkId, fusionScore: rrf(ranks, k), vectorRank: vr, lexicalRank: lr });
  }
  fused.sort((a, b) => b.fusionScore - a.fusionScore);
  return fused;
}
