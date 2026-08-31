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
