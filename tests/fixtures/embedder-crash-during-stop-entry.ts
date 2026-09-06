import { join } from "node:path";
import { LocalTransformersEmbedder } from "../../packages/embeddings/src/local-transformers.ts";

const modelPath = join(import.meta.dir, "../../models/default");
const embedder = new LocalTransformersEmbedder({
  modelPath,
  workerUrl: new URL("./crash-embed-worker.ts", import.meta.url),
});
const pending = embedder.embed(["boom"]);
embedder.stop();
await pending.catch(() => undefined);
process.stdout.write("done\n");
