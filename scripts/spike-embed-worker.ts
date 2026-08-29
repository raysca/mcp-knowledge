const worker = new Worker(
  new URL("./spike-embed-worker-thread.ts", import.meta.url),
);

const result = await new Promise<{ dims: number }>((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("embed worker timed out")),
    120_000,
  );
  worker.onmessage = (event: MessageEvent<{ dims: number }>) => {
    clearTimeout(timeout);
    resolve(event.data);
  };
  worker.onerror = (event) => {
    clearTimeout(timeout);
    reject(new Error(event.message));
  };
  worker.postMessage({ id: "1", text: "hello world" });
});

if (result.dims !== 384) {
  throw new Error(`worker dims ${result.dims}`);
}
console.log("embed worker ok", result.dims);
process.exit(0);
