import { fileURLToPath } from "node:url";
import { mapAnyDocError } from "../adapters/anydoc/map.ts";
import { ParserError } from "../errors.ts";
import type { NormalizedDocument } from "@mcp-knowledge/core";

const DEFAULT_ENTRY = fileURLToPath(new URL("./subprocess-entry.ts", import.meta.url));

export async function parseInSubprocess(
  bytes: Uint8Array,
  timeoutMs: number,
  entryPath: string = DEFAULT_ENTRY,
  signal?: AbortSignal,
): Promise<NormalizedDocument> {
  const proc = Bun.spawn(["bun", "run", entryPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const kill = () => {
    if (proc.exitCode === null) proc.kill();
  };
  const abort = () => kill();
  const timeout = setTimeout(kill, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) kill();
    try {
      await proc.stdin.write(bytes);
      await proc.stdin.end();
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
    const [out, stderrText, exitCode] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      proc.exited,
    ]);
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    if (exitCode !== 0) {
      throw new ParserError(
        "DOCUMENT_MALFORMED",
        `anydoc subprocess exit ${exitCode}: ${stderrText.slice(0, 500)}`,
      );
    }
    const result = JSON.parse(out) as {
      ok: boolean;
      doc?: NormalizedDocument;
      code?: string;
      message?: string;
    };
    if (!result.ok) throw mapAnyDocError(result.code ?? "malformed", result.message);
    if (!result.doc) throw new ParserError("DOCUMENT_MALFORMED", "empty anydoc reply");
    return result.doc;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (proc.exitCode === null) {
      proc.kill();
      await proc.exited;
    }
  }
}
