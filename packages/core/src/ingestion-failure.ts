import { AppError } from "./errors.ts";

export type PublicIngestionFailure = {
  code: IngestionFailureCode;
  message: string;
};

export const PUBLIC_INGESTION_FAILURES = {
  DOCUMENT_NEEDS_OCR: "This document needs OCR before it can be ingested.",
  DOCUMENT_ENCRYPTED: "This document is password-protected.",
  DOCUMENT_UNSUPPORTED_FORMAT: "This file format is not supported.",
  DOCUMENT_RESOURCE_LIMIT: "This file is too large or complex to ingest.",
  PAYLOAD_TOO_LARGE: "This upload is too large.",
  INGESTION_TIMEOUT: "Ingestion timed out.",
  DOCUMENT_MALFORMED: "This file could not be read.",
} as const;

export type IngestionFailureCode = keyof typeof PUBLIC_INGESTION_FAILURES;

function codeOf(error: unknown): string | undefined {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return undefined;
}

export function publicIngestionFailure(error: unknown): PublicIngestionFailure {
  const code = codeOf(error);
  if (code && code in PUBLIC_INGESTION_FAILURES) {
    const knownCode = code as IngestionFailureCode;
    return { code: knownCode, message: PUBLIC_INGESTION_FAILURES[knownCode] };
  }
  return { code: "DOCUMENT_MALFORMED", message: PUBLIC_INGESTION_FAILURES.DOCUMENT_MALFORMED };
}
