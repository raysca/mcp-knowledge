import { describe, expect, test } from "bun:test";
import {
  deriveMetricFloors,
  evaluateQueries,
  type EvaluationQuery,
  type EvaluationResult,
} from "./evaluator.ts";

function answerable(query: string, relevant: string[]): EvaluationQuery {
  return { query, relevant, category: "lexical" };
}

describe("evaluateQueries", () => {
  test("derives metric floors from the lowest runs rounded down to two decimals", () => {
    expect(deriveMetricFloors([
      { recallAt5: 0.999, recallAt10: 0.918, mrr: 0.339 },
      { recallAt5: 0.981, recallAt10: 0.919, mrr: 0.331 },
      { recallAt5: 0.992, recallAt10: 0.917, mrr: 0.335 },
    ])).toEqual({ recallAt5: 0.98, recallAt10: 0.91, mrr: 0.33 });
  });

  test("scores a rank-one relevant document with MRR one", () => {
    const result: EvaluationResult = {
      query: answerable("exact identifier", ["doc_returns"]),
      documentIds: ["doc_returns", "doc_other"],
      latencyMs: 12,
    };

    expect(evaluateQueries([result]).answerable).toEqual({
      queries: 1,
      recallAt5: 1,
      recallAt10: 1,
      mrr: 1,
    });
  });

  test("scores a rank-four relevant document with reciprocal rank .25", () => {
    const result: EvaluationResult = {
      query: answerable("fourth result", ["doc_four"]),
      documentIds: ["doc_one", "doc_two", "doc_three", "doc_four"],
    };

    expect(evaluateQueries([result]).answerable.mrr).toBe(0.25);
  });

  test("scores a miss as zero", () => {
    const result: EvaluationResult = {
      query: answerable("missing", ["doc_target"]),
      documentIds: ["doc_one", "doc_two"],
    };

    expect(evaluateQueries([result]).answerable).toEqual({
      queries: 1,
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
    });
  });

  test("uses the first of multiple relevant document IDs", () => {
    const result: EvaluationResult = {
      query: answerable("either policy copy", ["doc_old", "doc_current"]),
      documentIds: ["doc_other", "doc_current", "doc_old"],
    };

    expect(evaluateQueries([result]).answerable.mrr).toBe(0.5);
  });

  test("excludes no-answer queries from answerable metrics and reports returned hits", () => {
    const noAnswer: EvaluationQuery = {
      query: "What is the office Wi-Fi password?",
      relevant: [],
      category: "no-answer",
    };
    const report = evaluateQueries([
      { query: answerable("known", ["doc_known"]), documentIds: ["doc_known"] },
      { query: noAnswer, documentIds: ["doc_unrelated"] },
      { query: noAnswer, documentIds: [] },
    ]);

    expect(report.answerable.queries).toBe(1);
    expect(report.noAnswer).toEqual({
      queries: 2,
      queriesWithHits: 1,
      retrievalRate: 0.5,
    });
  });

  test("reports sorted p50 and p95 latency using ceil(p*n)-1", () => {
    const report = evaluateQueries([
      { query: answerable("a", ["a"]), documentIds: ["a"], latencyMs: 40 },
      { query: answerable("b", ["b"]), documentIds: ["b"], latencyMs: 10 },
      { query: answerable("c", ["c"]), documentIds: ["c"], latencyMs: 30 },
      { query: answerable("d", ["d"]), documentIds: ["d"], latencyMs: 20 },
    ]);

    expect(report.latencyMs).toEqual({ p50: 20, p95: 40 });
  });
});
