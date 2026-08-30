import type { DocumentParser } from "@mcp-knowledge/core";
import type { ParserRegistry } from "@mcp-knowledge/core";

export function createParserRegistry(parsers: DocumentParser[]): ParserRegistry {
  return {
    find(input) {
      return parsers.find((p) => p.supports(input));
    },
  };
}

export type {
  DocumentBlock,
  DocumentParser,
  NormalizedDocument,
  SourceLocation,
} from "./types.ts";
export { ParserError } from "./errors.ts";
export { NativeTextParser } from "./adapters/native-text.ts";
export { AnyDocParser } from "./adapters/anydoc/adapter.ts";
export { parseInSubprocess } from "./anydoc/subprocess-runner.ts";
