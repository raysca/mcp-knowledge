import type { Embedder } from "@mcp-knowledge/core";

type Pending = {
  resolve: (v: number[][]) => void;
  reject: (e: Error) => void;
};

export class LocalTransformersEmbedder implements Embedder {
  readonly name = "local-transformers";
  readonly model = "Xenova/all-MiniLM-L6-v2";
  readonly version = "1";
  readonly dimensions = 384;

  private worker!: Worker;
  private readonly pending = new Map<string, Pending>();
  private readonly modelPath: string;
  private readonly workerUrl: URL;
  private stopped = false;
  private workerGeneration = 0;

  constructor(input: { modelPath: string; workerUrl?: URL }) {
    this.modelPath = input.modelPath;
    this.workerUrl = new URL("./worker-thread.ts", import.meta.url);
    this.spawn(input.workerUrl ?? this.workerUrl);
  }

  private spawn(url: URL) {
    const worker = new Worker(url);
    const generation = ++this.workerGeneration;
    this.worker = worker;
    worker.onmessage = (
      event: MessageEvent<{ id: string; vectors?: number[][]; error?: string }>,
    ) => {
      const p = this.pending.get(event.data.id);
      if (!p) return;
      this.pending.delete(event.data.id);
      if (event.data.error) p.reject(new Error(event.data.error));
      else p.resolve(event.data.vectors ?? []);
    };
    const onFatal = (err: Error) => {
      if (generation !== this.workerGeneration) return;
      (worker as Worker & { unref(): void }).unref();
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      // ponytail: never Worker.terminate() after ONNX NAPI load — Bun 1.3.13 panics
      // (NAPI FATAL ERROR / SIGTRAP). Orphan the dead isolate and spawn a fresh Worker.
      if (!this.stopped) this.spawn(this.workerUrl);
    };
    worker.onerror = (e) => onFatal(new Error(`embedding worker crashed: ${e.message}`));
    worker.onmessageerror = () =>
      onFatal(new Error("embedding worker sent an unparseable message"));
  }

  embed(texts: string[]): Promise<number[][]> {
    if (this.stopped) return Promise.reject(new Error("embedding worker is stopped"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, texts, modelPath: this.modelPath });
    });
  }

  stop(): void {
    this.stopped = true;
    (this.worker as Worker & { unref(): void }).unref();
  }
}
