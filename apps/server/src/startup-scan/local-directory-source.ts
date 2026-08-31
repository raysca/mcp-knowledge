import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import { AppError } from "@mcp-knowledge/core";

export type SourceCandidate = { relativePath: string };

type FileSnapshot = { size: number; mtimeMs: number; ino: number };

const ENUMERATION_VERSION = "local-directory-v1";

export function fileSnapshotChanged(before: FileSnapshot, after: FileSnapshot): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino;
}

function sha256(value: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}

export class LocalDirectorySource {
  readonly sourceId: string;
  readonly configurationFingerprint: string;

  private constructor(
    private readonly canonicalRoot: string,
    private readonly maxDepth: number,
  ) {
    this.sourceId = sha256(`local\0${canonicalRoot}`);
    this.configurationFingerprint = sha256(
      `${this.sourceId}\0${this.maxDepth}\0${ENUMERATION_VERSION}`,
    );
  }

  static async create(input: { root: string; maxDepth: number }): Promise<LocalDirectorySource> {
    const canonicalRoot = await realpath(input.root);
    const rootStats = await stat(canonicalRoot);
    if (!rootStats.isDirectory()) {
      throw new Error("Local directory source root must be a directory.");
    }
    return new LocalDirectorySource(canonicalRoot, input.maxDepth);
  }

  async *candidates(signal: AbortSignal): AsyncIterable<SourceCandidate> {
    throwIfAborted(signal);
    const entries = fg.globStream("**/*", {
      cwd: this.canonicalRoot,
      objectMode: true,
      deep: this.maxDepth + 1,
      dot: false,
      followSymbolicLinks: false,
      onlyFiles: true,
      signal,
    } as fg.Options & { signal: AbortSignal });

    for await (const entry of entries as AsyncIterable<{
      path: string;
      dirent: { isFile(): boolean; isSymbolicLink(): boolean };
    }>) {
      throwIfAborted(signal);
      if (!entry.dirent.isFile() || entry.dirent.isSymbolicLink()) continue;
      const relativePath = entry.path.replaceAll("\\", "/");
      if (this.resolveCandidate(relativePath)) yield { relativePath };
    }
  }

  async inspectAndRead(
    candidate: SourceCandidate,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }> {
    throwIfAborted(signal);
    const filePath = this.requireCandidatePath(candidate.relativePath);
    const entryStats = await lstat(filePath);
    if (!entryStats.isFile() || entryStats.isSymbolicLink()) {
      throw new Error("Source candidate must be a regular file.");
    }

    const file = await open(filePath, "r");
    try {
      throwIfAborted(signal);
      const before = await file.stat();
      if (before.size > maxBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE", "Source file exceeds the byte limit.", 413);
      }

      const bytes = new Uint8Array(before.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        throwIfAborted(signal);
        const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }

      const after = await file.stat();
      if (fileSnapshotChanged(before, after)) {
        throw new AppError("SOURCE_FILE_UNSTABLE", "Source file changed while it was read.", 409);
      }

      const contents = bytes.subarray(0, offset);
      return { bytes: contents, sizeBytes: contents.byteLength, sha256: sha256(contents) };
    } finally {
      await file.close();
    }
  }

  async pathState(relativePath: string): Promise<"present" | "missing" | "unknown"> {
    const filePath = this.resolveCandidate(relativePath);
    if (!filePath) return "unknown";

    try {
      const entryStats = await lstat(filePath);
      return entryStats.isFile() && !entryStats.isSymbolicLink() ? "present" : "unknown";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      return "unknown";
    }
  }

  private requireCandidatePath(relativePath: string): string {
    const filePath = this.resolveCandidate(relativePath);
    if (!filePath) throw new Error("Source candidate path is unsafe.");
    return filePath;
  }

  private resolveCandidate(relativePath: string): string | undefined {
    const normalized = relativePath.replaceAll("\\", "/");
    if (!normalized || isAbsolute(normalized) || normalized.split("/").includes("..")) {
      return undefined;
    }

    const filePath = resolve(this.canonicalRoot, normalized);
    const fromRoot = relative(this.canonicalRoot, filePath);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return undefined;
    }
    return filePath;
  }
}
