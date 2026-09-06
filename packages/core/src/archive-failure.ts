import { AppError } from "./errors.ts";

export type PublicArchiveFailure = {
  code: ArchiveFailureCode;
  message: string;
};

export const PUBLIC_ARCHIVE_FAILURES = {
  ARCHIVE_TOO_LARGE: "This archive exceeds the configured entry or size limit.",
  ARCHIVE_MALFORMED: "This archive could not be read.",
} as const;

export type ArchiveFailureCode = keyof typeof PUBLIC_ARCHIVE_FAILURES;

function codeOf(error: unknown): string | undefined {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error) return String((error as { code: unknown }).code);
  return undefined;
}

export function publicArchiveFailure(error: unknown): PublicArchiveFailure {
  const code = codeOf(error);
  if (code && Object.hasOwn(PUBLIC_ARCHIVE_FAILURES, code)) {
    const knownCode = code as ArchiveFailureCode;
    return { code: knownCode, message: PUBLIC_ARCHIVE_FAILURES[knownCode] };
  }
  return { code: "ARCHIVE_MALFORMED", message: PUBLIC_ARCHIVE_FAILURES.ARCHIVE_MALFORMED };
}
