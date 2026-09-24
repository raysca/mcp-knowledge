import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@mcp-knowledge/core";

export const METADATA_MANIFEST_NAME = ".mcp-knowledge-manifest.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type Rule = { glob: Bun.Glob; metadata: Record<string, unknown> };
export type MetadataManifest = {
  fingerprint: string;
  metadataForPath(relativePath: string): Record<string, unknown>;
};

function invalid(reason: string): AppError {
  return new AppError("INVALID_INGEST_MANIFEST", `Invalid ingest metadata manifest: ${reason}`, 400);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMetadata(metadata: Record<string, unknown>): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: metadata, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > 64) throw invalid("metadata nesting exceeds 64 levels.");
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
    } else if (isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(key)) throw invalid("unsafe metadata key.");
        pending.push({ value: child, depth: depth + 1 });
      }
    } else {
      throw invalid("metadata must contain only JSON values and finite numbers.");
    }
  }
}

function parseRules(contents: string): Rule[] {
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch { throw invalid("malformed JSON."); }
  if (!isObject(value) || Object.keys(value).length !== 1 || !Array.isArray(value.rules)) {
    throw invalid("expected an object containing only a rules array.");
  }
  return value.rules.map((rule: unknown) => {
    if (!isObject(rule) || Object.keys(rule).length !== 2 || typeof rule.glob !== "string" || !isObject(rule.metadata)) {
      throw invalid("each rule must contain only a glob string and metadata object.");
    }
    // A deliberately small glob language avoids brace/extglob expansion introducing
    // traversal or platform-specific escaping before Bun.Glob sees the pattern.
    const segments = rule.glob.split("/");
    if (/[\\:\u0000-\u001f\u007f{}[\]()!]/.test(rule.glob) ||
        segments.some((segment) => !segment || segment === "." || segment === ".." ||
          (segment.includes("**") && segment !== "**"))) {
      throw invalid("globs must be relative forward-slash paths using only *, **, or ? wildcards.");
    }
    validateMetadata(rule.metadata);
    return { glob: new Bun.Glob(rule.glob), metadata: rule.metadata };
  });
}

export async function loadMetadataManifest(canonicalRoot: string): Promise<MetadataManifest> {
  const path = join(canonicalRoot, METADATA_MANIFEST_NAME);
  let entry;
  try { entry = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { fingerprint: "absent", metadataForPath: () => ({}) };
    }
    throw invalid("cannot inspect manifest file.");
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw invalid("expected a regular non-symlink file.");
  if (entry.size > MAX_MANIFEST_BYTES) throw invalid("file exceeds the 1 MiB limit.");

  // O_NOFOLLOW closes the final-component symlink race. O_NONBLOCK prevents a
  // replaced FIFO from blocking before fstat rejects it as a non-regular file.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw invalid("cannot safely open manifest file."); });
  let contents: Uint8Array;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.ino !== entry.ino || before.dev !== entry.dev || before.size > MAX_MANIFEST_BYTES) {
      throw invalid("manifest file changed or exceeds the 1 MiB limit.");
    }
    contents = new Uint8Array(before.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await file.read(contents, offset, contents.byteLength - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) {
      throw invalid("manifest file changed while being read.");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid("cannot read a stable manifest file.");
  } finally { await file.close(); }

  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(contents); }
  catch { throw invalid("expected UTF-8 JSON."); }
  const rules = parseRules(text);
  const fingerprint = new Bun.CryptoHasher("sha256").update(contents).digest("hex");
  return {
    fingerprint,
    metadataForPath(relativePath) {
      let metadata: Record<string, unknown> = {};
      for (const rule of rules) {
        if (rule.glob.match(relativePath)) metadata = { ...metadata, ...rule.metadata };
      }
      return structuredClone(metadata);
    },
  };
}
