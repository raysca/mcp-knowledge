/// <reference lib="webworker" />
import { env, pipeline } from "@huggingface/transformers";

env.allowRemoteModels = false;
env.allowLocalModels = true;

type Extractor = (
  texts: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

let extractor: Extractor | undefined;

async function getExtractor(modelPath: string): Promise<Extractor> {
  if (!extractor) {
    extractor = (await pipeline("feature-extraction", modelPath, {
      local_files_only: true,
      dtype: "uint8",
    })) as Extractor;
  }
  return extractor;
}

self.onmessage = async (
  event: MessageEvent<{ id: string; texts: string[]; modelPath: string }>,
) => {
  try {
    const extractor = await getExtractor(event.data.modelPath);
    const out = await extractor(event.data.texts, { pooling: "mean", normalize: true });
    const vectors = out.tolist();
    if (!Array.isArray(vectors) || vectors.some((v) => !Array.isArray(v) || v.length !== 384)) {
      postMessage({ id: event.data.id, error: "embedding dimensions !== 384" });
      return;
    }
    postMessage({ id: event.data.id, vectors });
  } catch (error) {
    postMessage({
      id: event.data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
