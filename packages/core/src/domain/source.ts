export type SourceFileOutcome =
  | "imported"
  | "unchanged"
  | "duplicate"
  | "unsupported"
  | "oversized"
  | "failed";

export type SourceFileRecord = {
  sourceId: string;
  relativePath: string;
  sha256?: string;
  documentId?: string;
  lastOutcome: SourceFileOutcome;
  scanCycle: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SourceScanCycle = { cycleId: string; resumed: boolean };

export type PreparedSourceDocument = {
  documentId: string;
  revisionId: string;
  originalFilename: string;
  mimeType: string;
  extension?: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
  storageKey: string;
};

type CommitSourceImportBase = {
  sourceId: string;
  relativePath: string;
  scanCycle: string;
  sha256: string;
};

export type CommitSourceImportInput = CommitSourceImportBase &
  (
    | {
        mode: "import";
        prepared: PreparedSourceDocument;
        replaceDocumentId?: string;
      }
    | {
        mode: "duplicate";
        duplicateDocumentId: string;
        replaceDocumentId: string;
      }
  );

export type CommitSourceImportResult =
  | {
      outcome: "imported";
      documentId: string;
      jobId: string;
      retiredDocumentId?: string;
    }
  | {
      outcome: "duplicate";
      duplicateDocumentId: string;
      retiredDocumentId?: string;
    };
