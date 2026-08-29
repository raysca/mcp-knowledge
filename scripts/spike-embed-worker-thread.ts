/// <reference lib="webworker" />
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";

type Extractor = (
  texts: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
env.allowRemoteModels = false;
env.allowLocalModels = true;

const extractor = (await pipeline(
  "feature-extraction",
  join(root, "models", "default"),
  { local_files_only: true, dtype: "uint8" },
)) as Extractor;

self.onmessage = async (event: MessageEvent<{ id: string; text: string }>) => {
  const out = await extractor(event.data.text, {
    pooling: "mean",
    normalize: true,
  });
  const vec = out.tolist()[0] ?? [];
  postMessage({ id: event.data.id, dims: vec.length });
};
