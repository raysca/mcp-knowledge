import { fileURLToPath } from "node:url";
import { mapAnyDocError } from "../adapters/anydoc/map.ts";
import { ParserError } from "../errors.ts";
import type { NormalizedDocument } from "@mcp-knowledge/core";

const DEFAULT_ENTRY = fileURLToPath(new URL("./subprocess-entry.ts", import.meta.url));

export async function parseInSubprocess(
  bytes: Uint8Array,
  timeoutMs: number,
  entryPath: string = DEFAULT_ENTRY,
): Promise<NormalizedDocument> {
  const proc = Bun.spawn(["bun", "run", entryPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  await proc.stdin.write(bytes);
  await proc.stdin.end();
  const [out, stderrText, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    proc.exited,
  ]);
  clearTimeout(timeout);
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
}
