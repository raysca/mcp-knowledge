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

export type EvaluationFloors = Pick<AnswerableMetrics, "recallAt5" | "recallAt10" | "mrr">;

export type EvaluationReport = {
  answerable: AnswerableMetrics;
  byCategory: Partial<Record<Exclude<EvaluationCategory, "no-answer">, AnswerableMetrics>>;
  noAnswer: {
    queries: number;
    queriesWithHits: number;
    retrievalRate: number;
    falsePositiveRate: number;
    policy: "any-returned-document";
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
    const ids = [...new Set(result.documentIds)];
    const relevant = new Set(result.query.relevant);
    const rank = ids.findIndex((id) => relevant.has(id)) + 1;
    if (rank === 0) continue;
    reciprocalRanks += 1 / rank;
    hitsAt5 += ids.slice(0, 5).filter((id) => relevant.has(id)).length / relevant.size;
    hitsAt10 += ids.slice(0, 10).filter((id) => relevant.has(id)).length / relevant.size;
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

export function deriveMetricFloors(runs: EvaluationFloors[]): EvaluationFloors {
  if (runs.length === 0) throw new Error("At least one evaluation run is required.");
  const floor = (value: number) => Math.floor(value * 100) / 100;
  return {
    recallAt5: floor(Math.min(...runs.map((run) => run.recallAt5))),
    recallAt10: floor(Math.min(...runs.map((run) => run.recallAt10))),
    mrr: floor(Math.min(...runs.map((run) => run.mrr))),
  };
}

export function evaluateQueries(results: EvaluationResult[]): EvaluationReport {
  for (const { query } of results) {
    if ((query.category === "no-answer") !== (query.relevant.length === 0)) {
      throw new Error("Only no-answer queries may have no relevant documents.");
    }
  }
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
  // Retrieval-only policy: any result for an unanswerable query is a false
  // positive. There is no score threshold or downstream answer generation here.
  const queriesWithHits = noAnswer.filter((result) => result.documentIds.length > 0).length;
  const falsePositiveRate = noAnswer.length === 0 ? 0 : queriesWithHits / noAnswer.length;

  return {
    answerable: metrics(answerable),
    byCategory,
    noAnswer: {
      queries: noAnswer.length,
      queriesWithHits,
      retrievalRate: falsePositiveRate,
      falsePositiveRate,
      policy: "any-returned-document",
    },
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };
}
