export type ArchiveImportState =
  | "queued"
  | "extracting"
  | "completed"
  | "completed_with_errors"
  | "failed";

export type ArchiveImportEntryOutcome =
  | "extracted"
  | "duplicate"
  | "unsupported"
  | "oversized"
  | "failed";

export type ArchiveImportEntry = {
  path: string;
  outcome: ArchiveImportEntryOutcome;
  documentId?: string;
  error?: string;
};

export type ArchiveImport = {
  id: string;
  originalFilename: string;
  collectionId?: string;
  metadata: Record<string, unknown>;
  state: ArchiveImportState;
  entries: ArchiveImportEntry[];
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
};
