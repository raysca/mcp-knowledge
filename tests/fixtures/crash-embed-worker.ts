/// <reference lib="webworker" />
self.onmessage = () => {
  throw new Error("intentional embedder crash");
};
