import { describe, expect, test } from "bun:test";
import { hybridRrf, rrf } from "../../packages/core/src/retrieval/rrf.ts";

describe("rrf", () => {
  test("sums 1/(k+rank) across ranks", () => {
    expect(rrf([1, 2], 60)).toBeCloseTo(1 / 61 + 1 / 62);
  });

  test("hybrid fusion prefers items that rank on both sides", () => {
    const fused = hybridRrf(
      [{ chunkId: "a" }, { chunkId: "b" }],
      [{ chunkId: "b" }, { chunkId: "c" }],
      60,
    );
    expect(fused[0]?.chunkId).toBe("b");
    expect(fused[0]?.vectorRank).toBe(2);
    expect(fused[0]?.lexicalRank).toBe(1);
    expect(fused.map((h) => h.chunkId).sort()).toEqual(["a", "b", "c"]);
  });
});
