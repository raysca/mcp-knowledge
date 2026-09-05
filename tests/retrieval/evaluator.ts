export type EvaluationCategory =
  | "lexical"
  | "semantic"
  | "confusable"
  | "provenance"
  | "no-answer";

export type EvaluationQuery = {
  query: string;
  relevant: string[];
  category: EvaluationCategory;
};

export type EvaluationResult = {
  query: EvaluationQuery;
  documentIds: string[];
  latencyMs?: number;
};

export type AnswerableMetrics = {
  queries: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
};

export type EvaluationReport = {
  answerable: AnswerableMetrics;
  byCategory: Partial<Record<Exclude<EvaluationCategory, "no-answer">, AnswerableMetrics>>;
  noAnswer: {
    queries: number;
    queriesWithHits: number;
    retrievalRate: number;
  };
  latencyMs: {
    p50: number | null;
    p95: number | null;
  };
};

function metrics(results: EvaluationResult[]): AnswerableMetrics {
  let hitsAt5 = 0;
  let hitsAt10 = 0;
  let reciprocalRanks = 0;

  for (const result of results) {
    const rank = result.documentIds.findIndex((id) => result.query.relevant.includes(id)) + 1;
    if (rank === 0) continue;
    reciprocalRanks += 1 / rank;
    if (rank <= 5) hitsAt5++;
    if (rank <= 10) hitsAt10++;
  }

  const queries = results.length;
  return {
    queries,
    recallAt5: queries === 0 ? 0 : hitsAt5 / queries,
    recallAt10: queries === 0 ? 0 : hitsAt10 / queries,
    mrr: queries === 0 ? 0 : reciprocalRanks / queries,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(p * sorted.length) - 1]!;
}

export function evaluateQueries(results: EvaluationResult[]): EvaluationReport {
  const answerable = results.filter((result) => result.query.category !== "no-answer");
  const noAnswer = results.filter((result) => result.query.category === "no-answer");
  const byCategory: EvaluationReport["byCategory"] = {};
  for (const category of ["lexical", "semantic", "confusable", "provenance"] as const) {
    const categoryResults = answerable.filter((result) => result.query.category === category);
    if (categoryResults.length > 0) byCategory[category] = metrics(categoryResults);
  }
  const latencies = results
    .map((result) => result.latencyMs)
    .filter((latency): latency is number => latency !== undefined)
    .sort((a, b) => a - b);

  return {
    answerable: metrics(answerable),
    byCategory,
    noAnswer: {
      queries: noAnswer.length,
      queriesWithHits: noAnswer.filter((result) => result.documentIds.length > 0).length,
      retrievalRate: noAnswer.length === 0
        ? 0
        : noAnswer.filter((result) => result.documentIds.length > 0).length / noAnswer.length,
    },
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };
}
