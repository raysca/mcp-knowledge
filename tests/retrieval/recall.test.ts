import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import queries from "./queries.json";
import baseline from "./baseline.json";
import evaluationRuns from "./evaluation-runs.json";
import magicVoiceQueries from "./magic-voice-queries.json";
import {
  deriveMetricFloors,
  evaluateQueries,
  type EvaluationQuery,
  type EvaluationResult,
} from "./evaluator.ts";

const allowedFixtureExtensions = new Set([".html", ".json", ".md", ".txt", ".xml"]);

type RetrievalHit = {
  documentId: string;
  headingPath: string[];
  location?: { charStart?: number; charEnd?: number };
  matchingChunkCount?: number;
  matchedHeadings?: string[];
  ranking?: { finalRank: number };
};

function hasStructuralProvenance(hit: RetrievalHit): boolean {
  if (hit.headingPath.length > 0) return true;
  const { charStart, charEnd } = hit.location ?? {};
  return (
    typeof charStart === "number" &&
    typeof charEnd === "number" &&
    Number.isInteger(charStart) &&
    Number.isInteger(charEnd) &&
    charStart >= 0 &&
    charEnd > charStart
  );
}

async function waitReady(base: string, id: string, ms = 60_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const res = await fetch(`${base}/api/v1/documents/${id}`);
    const doc = (await res.json()) as { status?: string };
    if (doc.status === "ready") return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${id}`);
}

describe("retrieval recall", () => {
  let dir = "";
  let server: Bun.Server<undefined>;
  let base = "";
  let stop: () => void;
  const fileToDoc = new Map<string, string>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-recall-"));
    const env = loadEnv({
      DATABASE_URL: `file:${join(dir, "app.db")}`,
      STORAGE_PATH: join(dir, "blobs"),
    });
    const app = await createApp(env);
    stop = app.stop;
    server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${server.port}`;
    const corpus = join(import.meta.dir, "corpus");
    for (const name of (await readdir(corpus)).sort()) {
      const extension = name.slice(name.lastIndexOf("."));
      if (!allowedFixtureExtensions.has(extension)) continue;
      const body = await Bun.file(join(corpus, name)).text();
      const form = new FormData();
      form.set("file", new File([body], name));
      const created = await fetch(`${base}/api/v1/documents`, { method: "POST", body: form });
      const json = (await created.json()) as { id: string };
      await waitReady(base, json.id);
      fileToDoc.set(name, json.id);
    }
  }, 180_000);

  afterAll(async () => {
    stop();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("answerable queries meet committed floors with attributable hits", async () => {
    const results: EvaluationResult[] = [];
    for (const query of queries as EvaluationQuery[]) {
      const evaluatedQuery: EvaluationQuery = {
        ...query,
        relevant: query.relevant.map((filename) => {
          const documentId = fileToDoc.get(filename);
          expect(documentId).toBeDefined();
          return documentId!;
        }),
      };
      const startedAt = performance.now();
      const res = await fetch(`${base}/api/v1/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: query.query, mode: "hybrid", limit: 10 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hits: RetrievalHit[] };
      if (query.category !== "no-answer") {
        const relevantHit = body.hits.find((hit) => evaluatedQuery.relevant.includes(hit.documentId));
        expect(relevantHit).toBeDefined();
        expect(hasStructuralProvenance(relevantHit!)).toBe(true);
      }
      results.push({
        query: evaluatedQuery,
        documentIds: body.hits.map((hit) => hit.documentId),
        latencyMs: performance.now() - startedAt,
      });
    }
    const report = evaluateQueries(results);
    console.log(JSON.stringify(report));
    const recordedFloors = deriveMetricFloors(evaluationRuns.runs);
    expect(evaluationRuns.floor).toEqual(recordedFloors);
    expect({
      recallAt5: baseline.recallAt5,
      recallAt10: baseline.recallAt10,
      mrr: baseline.mrr,
    }).toEqual(recordedFloors);
    expect(report.answerable.recallAt5).toBeGreaterThanOrEqual(baseline.recallAt5);
    expect(report.answerable.recallAt10).toBeGreaterThanOrEqual(baseline.recallAt10);
    expect(report.answerable.mrr).toBeGreaterThanOrEqual(baseline.mrr);
  }, 180_000);

  for (const mode of ["hybrid", "lexical"] as const) {
    test(`Magic Voice-style ${mode} search returns attributable distinct documents`, async () => {
      const results: EvaluationResult[] = [];
      for (const query of magicVoiceQueries as EvaluationQuery[]) {
        const evaluatedQuery = {
          ...query,
          relevant: query.relevant.map((filename) => {
            const id = fileToDoc.get(filename);
            expect(id).toBeDefined();
            return id!;
          }),
        };
        const startedAt = performance.now();
        const res = await fetch(`${base}/api/v1/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: query.query, mode, collapse: "document", limit: 10 }),
        });
        expect(res.status).toBe(200);
        const { hits } = (await res.json()) as { hits: RetrievalHit[] };
        const latencyMs = performance.now() - startedAt;
        const documentIds = hits.map((hit) => hit.documentId);
        expect(new Set(documentIds).size).toBe(documentIds.length);
        expect(hits.length).toBeLessThanOrEqual(10);
        for (const [index, hit] of hits.entries()) {
          expect(hit.ranking?.finalRank).toBe(index + 1);
          expect(hit.matchingChunkCount).toBeGreaterThanOrEqual(1);
          expect(Array.isArray(hit.matchedHeadings)).toBe(true);
          expect(hasStructuralProvenance(hit)).toBe(true);
        }
        results.push({ query: evaluatedQuery, documentIds, latencyMs });
      }
      const report = evaluateQueries(results);
      console.log(JSON.stringify({ suite: "magic-voice-document", mode, ...report }));
      const recorded = evaluationRuns.magicVoice[mode];
      expect(recorded.floor).toEqual(deriveMetricFloors(recorded.runs));
      expect(report.answerable.recallAt5).toBeGreaterThanOrEqual(recorded.floor.recallAt5);
      expect(report.answerable.recallAt10).toBeGreaterThanOrEqual(recorded.floor.recallAt10);
      expect(report.answerable.mrr).toBeGreaterThanOrEqual(recorded.floor.mrr);
      expect(report.noAnswer.policy).toBe("any-returned-document");
      // Hybrid has no abstention threshold: report its false positives without
      // pretending a ceiling of 100% is a useful regression gate.
      if (mode === "lexical") {
        expect(report.noAnswer.falsePositiveRate).toBeLessThanOrEqual(
          evaluationRuns.magicVoice.lexical.falsePositiveRateCeiling,
        );
      }
      expect(report.latencyMs.p50).toBeGreaterThanOrEqual(0);
      expect(report.latencyMs.p95).toBeGreaterThanOrEqual(report.latencyMs.p50!);
    }, 180_000);
  }
});
