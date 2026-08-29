import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = join(root, "models", "default");

env.allowRemoteModels = false;
env.allowLocalModels = true;

const extractor = await pipeline("feature-extraction", modelPath, {
  local_files_only: true,
  dtype: "uint8",
});

const out = await extractor("hello world", { pooling: "mean", normalize: true });
const nested = (
  typeof (out as { tolist?: () => unknown }).tolist === "function"
    ? (out as { tolist: () => number[][] }).tolist()
    : [[]]
) as number[][];
const vec = nested[0] ?? [];
if (vec.length !== 384) {
  throw new Error(`dims ${vec.length}`);
}
console.log("embed ok", vec.length);
