import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LocalTransformersEmbedder } from "../../packages/embeddings/src/local-transformers.ts";

const modelPath = join(import.meta.dir, "../../models/default");

describe("embedder crash recovery", () => {
  test("a crashed worker rejects in-flight embed and the next call still works", async () => {
    const embedder = new LocalTransformersEmbedder({
      modelPath,
      workerUrl: new URL("../fixtures/crash-embed-worker.ts", import.meta.url),
    });
    await expect(embedder.embed(["boom"])).rejects.toThrow(/crashed|intentional/);
    const [vec] = await embedder.embed(["hello world"]);
    expect(vec).toHaveLength(384);
  }, 120_000);
});
