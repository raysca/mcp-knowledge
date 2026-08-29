import type { DocumentParser, NormalizedDocument } from "@mcp-knowledge/core";
import { parseInSubprocess } from "../../anydoc/subprocess-runner.ts";

const NATIVE = new Set(["txt", "md", "markdown", "html", "htm", "json", "xml"]);

export class AnyDocParser implements DocumentParser {
  name = "anydoc";
  version = "0.2.4";

  constructor(private readonly timeoutMs: number) {}

  supports(input: { mimeType?: string; extension?: string }): boolean {
    const ext = input.extension?.toLowerCase();
    if (ext && NATIVE.has(ext)) return false;
    return true;
  }

  async parse(input: {
    data: Blob;
    filename: string;
    mimeType?: string;
  }): Promise<NormalizedDocument> {
    const bytes = new Uint8Array(await input.data.arrayBuffer());
    return parseInSubprocess(bytes, this.timeoutMs);
  }
}
