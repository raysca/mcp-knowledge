export {};

class ReferencedRecoveryWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private readonly keepAlive = setInterval(() => undefined, 1_000);

  postMessage(): void {
    queueMicrotask(() => {
      this.onerror?.({ message: "first fatal event" } as ErrorEvent);
      this.onmessageerror?.({} as MessageEvent);
    });
  }

  unref(): void {
    clearInterval(this.keepAlive);
  }
}

Object.defineProperty(globalThis, "Worker", {
  configurable: true,
  value: ReferencedRecoveryWorker,
});

const { LocalTransformersEmbedder } = await import(
  "../../packages/embeddings/src/local-transformers.ts"
);
const embedder = new LocalTransformersEmbedder({ modelPath: "/unused" });
await embedder.embed(["trigger duplicate fatal callbacks"]).catch(() => undefined);
await Bun.sleep(0);
embedder.stop();
process.stdout.write("done\n");
