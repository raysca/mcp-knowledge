import { env, AutoTokenizer } from "@huggingface/transformers";

env.allowRemoteModels = false;

let encode: ((text: string) => number[]) | undefined;

export async function loadWordPiece(modelPath: string): Promise<(text: string) => number> {
  if (!encode) {
    const tokenizer = await AutoTokenizer.from_pretrained(modelPath, {
      local_files_only: true,
    });
    encode = (text: string) => tokenizer.encode(text, { add_special_tokens: false }) as number[];
  }
  const enc = encode;
  return (text: string) => enc(text).length;
}
