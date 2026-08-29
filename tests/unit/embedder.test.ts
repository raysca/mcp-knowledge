import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LocalTransformersEmbedder } from "../../packages/embeddings/src/local-transformers.ts";

const modelPath = join(import.meta.dir, "../../models/default");

describe("LocalTransformersEmbedder", () => {
  test("embeds to 384 dimensions from the vendored snapshot", async () => {
    const embedder = new LocalTransformersEmbedder({ modelPath });
    const [vec] = await embedder.embed(["hello world"]);
    expect(vec).toHaveLength(384);
    expect(vec!.every((n) => Number.isFinite(n))).toBe(true);
  }, 120_000);
});
