import { describe, expect, test } from "bun:test";
import { buildSearchRequest } from "../../apps/server/src/ui/pages/playground.tsx";

const base = {
  query: "cancellation terms",
  collectionIds: [] as string[],
  documentIds: [] as string[],
  metadataJson: "",
  mode: "hybrid" as const,
  limit: 8,
  expand: "none" as const,
  explain: true,
};

describe("buildSearchRequest", () => {
  test("explain hybrid posts to explain without empty filters", () => {
    const req = buildSearchRequest(base);
    expect(req.path).toBe("/api/v1/search/explain");
    expect(req.body).toEqual({
      query: "cancellation terms",
      mode: "hybrid",
      limit: 8,
    });
  });

  test("plain search includes filters, ids, and section expand", () => {
    const req = buildSearchRequest({
      ...base,
      query: "q",
      collectionIds: ["col_1"],
      documentIds: ["doc_1"],
      metadataJson: '{"dept":"legal"}',
      mode: "lexical",
      limit: 5,
      expand: "section",
      explain: false,
    });
    expect(req.path).toBe("/api/v1/search");
    expect(req.body).toEqual({
      query: "q",
      mode: "lexical",
      limit: 5,
      collectionIds: ["col_1"],
      documentIds: ["doc_1"],
      filters: { dept: "legal" },
      expand: { type: "section", before: 2, after: 2 },
    });
  });

  test("invalid metadata JSON throws", () => {
    expect(() => buildSearchRequest({ ...base, metadataJson: "{" })).toThrow(/metadata/i);
  });
});
