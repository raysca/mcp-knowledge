export function createShutdownHandler(input: {
  stopApp: () => void;
  stopServer: () => void | Promise<void>;
}): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () =>
    (stopping ??= (async () => {
      input.stopApp();
      await input.stopServer();
    })());
}
