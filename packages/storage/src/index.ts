import type { BlobStore } from "@mcp-knowledge/core";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type { BlobStore };

export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    return join(this.root, key);
  }

  async put(key: string, data: Blob): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, data);
  }

  async get(key: string): Promise<Blob> {
    const file = Bun.file(this.pathFor(key));
    if (!(await file.exists())) {
      throw new Error(`blob not found: ${key}`);
    }
    return file.slice();
  }

  async delete(key: string): Promise<void> {
    await Bun.file(this.pathFor(key)).unlink().catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    return Bun.file(this.pathFor(key)).exists();
  }
}

export function createBlobStore(input: {
  STORAGE_DRIVER: string;
  STORAGE_PATH: string;
}): BlobStore {
  if (input.STORAGE_DRIVER === "local") {
    return new LocalBlobStore(input.STORAGE_PATH);
  }
  throw new Error(`STORAGE_DRIVER ${input.STORAGE_DRIVER} is not implemented yet`);
}
