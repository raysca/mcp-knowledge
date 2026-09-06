import { createElement } from "react";

type IngestionError = {
  code: string;
  message: string;
  action: string;
};

const INGESTION_ERRORS: Record<string, IngestionError> = {
  DOCUMENT_NEEDS_OCR: {
    code: "DOCUMENT_NEEDS_OCR",
    message: "This document needs OCR before it can be ingested.",
    action: "Make the document searchable with OCR, then re-upload it.",
  },
  DOCUMENT_ENCRYPTED: {
    code: "DOCUMENT_ENCRYPTED",
    message: "This document is password-protected.",
    action: "Remove the password, then re-upload the file.",
  },
  DOCUMENT_UNSUPPORTED_FORMAT: {
    code: "DOCUMENT_UNSUPPORTED_FORMAT",
    message: "This file format is not supported.",
    action: "Convert the file to a supported format, then re-upload it.",
  },
  DOCUMENT_RESOURCE_LIMIT: {
    code: "DOCUMENT_RESOURCE_LIMIT",
    message: "This file is too large or complex to ingest.",
    action: "Split the file or reduce its size, then re-upload it.",
  },
  PAYLOAD_TOO_LARGE: {
    code: "PAYLOAD_TOO_LARGE",
    message: "This upload is too large.",
    action: "Split the file or reduce its size, then re-upload it.",
  },
  INGESTION_TIMEOUT: {
    code: "INGESTION_TIMEOUT",
    message: "Ingestion timed out.",
    action: "Retry once. If it fails again, check Jobs and troubleshooting.",
  },
  DOCUMENT_MALFORMED: {
    code: "DOCUMENT_MALFORMED",
    message: "This document could not be parsed.",
    action: "Re-export the file from its source application, then re-upload it.",
  },
};

const UNKNOWN: IngestionError = {
  code: "DOCUMENT_MALFORMED",
  message: "This document could not be parsed.",
  action: "Check Jobs and troubleshooting, then re-export the file before trying again.",
};

/** Reads only the stored code. Never return the persisted message because old rows may be unsafe. */
export function parseIngestionError(value: string | null | undefined): IngestionError {
  const code = typeof value === "string" ? value.match(/^([A-Z][A-Z0-9_]*): /)?.[1] : undefined;
  return code && INGESTION_ERRORS[code] ? INGESTION_ERRORS[code] : UNKNOWN;
}

/** A small reusable block for existing document and job views; all visible copy is fixed above. */
export function IngestionErrorDetails({ value }: { value: string | null | undefined }) {
  const failure = parseIngestionError(value);
  return createElement(
    "div",
    { className: "mt-2 rounded-lg border border-stamp/30 bg-stamp/5 p-3 text-xs text-stamp" },
    createElement("span", { className: "font-mono" }, failure.code),
    createElement("p", null, failure.message),
    createElement("p", { className: "text-slate" }, failure.action),
  );
}
