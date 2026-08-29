const ALLOWED_EXT = new Set([
  "pdf",
  "doc",
  "docx",
  "docm",
  "ppt",
  "pptx",
  "pptm",
  "xls",
  "xlsx",
  "xlsm",
  "csv",
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
  "json",
  "xml",
  "rtf",
  "epub",
  "odt",
  "ods",
  "odp",
]);

export function extensionOf(filename: string): string | undefined {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const i = base.lastIndexOf(".");
  if (i <= 0) return undefined;
  return base.slice(i + 1).toLowerCase();
}

export function sniffMime(bytes: Uint8Array, filename: string): string {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  if (bytes.length >= 5 && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) {
    return "application/rtf";
  }
  const ext = extensionOf(filename);
  if (ext === "json") return "application/json";
  if (ext === "xml") return "application/xml";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "csv") return "text/csv";
  if (ext === "txt") return "text/plain";
  if (ext === "docx" || ext === "docm") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (ext === "xlsx" || ext === "xlsm") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (ext === "pptx" || ext === "pptm") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (ext === "epub") return "application/epub+zip";
  return "application/octet-stream";
}

export function isAllowedUpload(filename: string): boolean {
  const ext = extensionOf(filename);
  return ext !== undefined && ALLOWED_EXT.has(ext);
}
