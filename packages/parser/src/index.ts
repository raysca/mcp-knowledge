import { NativeTextParser } from "./adapters/native-text.ts";
import type { DocumentParser } from "@mcp-knowledge/core";

export type ParserRegistry = {
  find(input: { mimeType?: string; extension?: string }): DocumentParser | undefined;
};

export function createParserRegistry(parsers: DocumentParser[] = [new NativeTextParser()]): ParserRegistry {
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
export { convertToNormalizedDocument } from "./anydoc/convert.ts";
export { mapAnyDocError, mapToNormalizedDocument } from "./adapters/anydoc/map.ts";
