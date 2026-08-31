import type { SourceImportService, SourceProcessResult } from "@mcp-knowledge/core";
import type { KnowledgeRepository } from "@mcp-knowledge/core";
import type { LocalDirectorySource, SourceCandidate } from "./local-directory-source.ts";

type StartupScanCounts = {
  discovered: number;
  examined: number;
  queued: number;
  unchanged: number;
  duplicates: number;
  unsupported: number;
  oversized: number;
  failed: number;
};

export type StartupScanStatus = {
  state: "disabled" | "scanning" | "completed" | "completed_with_errors" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  currentPath: string | null;
  counts: StartupScanCounts;
  limitReached: boolean;
  error: string | null;
  disabledReason: "not_configured" | "unsupported_profile" | "unsupported_role" | null;
};

type ScanSource = Pick<
  LocalDirectorySource,
  "sourceId" | "configurationFingerprint" | "candidates" | "inspectAndRead" | "pathState"
>;

type ScanRepository = Pick<
  KnowledgeRepository,
  "openSourceScan" | "getSourceFile" | "completeSourceScan"
>;

type ScanImporter = Pick<SourceImportService, "process">;

const emptyCounts = (): StartupScanCounts => ({
  discovered: 0,
  examined: 0,
  queued: 0,
  unchanged: 0,
  duplicates: 0,
  unsupported: 0,
  oversized: 0,
  failed: 0,
});

function disabledStatus(
  disabledReason: StartupScanStatus["disabledReason"],
): StartupScanStatus {
  return {
    state: "disabled",
    startedAt: null,
    completedAt: null,
    currentPath: null,
    counts: emptyCounts(),
    limitReached: false,
    error: null,
    disabledReason,
  };
}

function errorMessage(error: unknown): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error && error.message
        ? error.message
        : "Startup scan could not continue.";
  return message
    .replace(/[A-Za-z]:\\[^\s]*/g, "[path]")
    .replace(/\/(?:[^/\s]+(?:\/[^/\s]+)*)/g, "[path]")
    .slice(0, 240);
}

export class StartupIngestionCoordinator {
  private controller: AbortController | undefined;
  private hasStarted = false;
  private value: StartupScanStatus;

  constructor(
    private readonly input: {
      repo: ScanRepository;
      maxFiles: number;
      createSource?: () => Promise<ScanSource>;
      createImporter?: (source: ScanSource, signal: AbortSignal) => ScanImporter;
      disabledReason?: Exclude<StartupScanStatus["disabledReason"], null>;
      logger?: Pick<Console, "info" | "error">;
    },
  ) {
    this.value = disabledStatus(input.disabledReason ?? null);
  }

  start(): void {
    if (this.hasStarted || this.value.disabledReason) return;
    this.hasStarted = true;
    this.controller = new AbortController();
    this.value = {
      ...disabledStatus(null),
      state: "scanning",
      startedAt: new Date().toISOString(),
    };
    const signal = this.controller.signal;
    void this.run(signal).catch((error) => {
      if (signal.aborted) return;
      this.value.state = "failed";
      this.value.completedAt = new Date().toISOString();
      this.value.currentPath = null;
      this.value.error = errorMessage(error);
    });
  }

  status(): StartupScanStatus {
    return Object.freeze({
      ...this.value,
      counts: Object.freeze({ ...this.value.counts }),
    }) as StartupScanStatus;
  }

  stop(): void {
    this.controller?.abort(new DOMException("Startup scan stopped.", "AbortError"));
  }

  private async run(signal: AbortSignal): Promise<void> {
    let source: ScanSource;
    let sourceId: string | undefined;
    let startedLog = false;
    const logger = this.input.logger ?? console;

    try {
      logger.info({ event: "startup_scan_started" });
      startedLog = true;
      source = await this.requireSource();
      sourceId = source.sourceId;
      const importer = this.requireImporter(source, signal);

      const cycle = await this.input.repo.openSourceScan({
        sourceId: source.sourceId,
        configurationFingerprint: source.configurationFingerprint,
        proposedCycleId: crypto.randomUUID(),
      });

      for await (const candidate of source.candidates(signal)) {
        this.value.counts.discovered += 1;
        const previous = await this.input.repo.getSourceFile(source.sourceId, candidate.relativePath);
        if (previous?.scanCycle === cycle.cycleId) continue;
        if (this.value.counts.examined >= this.input.maxFiles) {
          this.value.limitReached = true;
          break;
        }

        this.value.counts.examined += 1;
        this.value.currentPath = candidate.relativePath;
        const result = await this.processCandidate(importer, candidate, cycle.cycleId, signal);
        this.countOutcome(result);
        if (result.outcome === "failed") {
          logger.error({
            event: "startup_scan_file_failed",
            sourceId: source.sourceId,
            relativePath: candidate.relativePath,
            outcome: result.outcome,
            errorCode: "SOURCE_FILE_FAILED",
            errorMessage: errorMessage(result.error),
          });
        }
      }

      if (signal.aborted) return;
      await this.input.repo.completeSourceScan({
        sourceId: source.sourceId,
        cycleId: cycle.cycleId,
        limitReached: this.value.limitReached,
      });
      if (signal.aborted) return;
      this.value.state = this.value.counts.failed > 0 ? "completed_with_errors" : "completed";
      this.value.completedAt = new Date().toISOString();
      this.value.currentPath = null;
      this.logCompletion(logger, sourceId);
    } catch (error) {
      if (signal.aborted) return;
      this.value.state = "failed";
      this.value.completedAt = new Date().toISOString();
      this.value.currentPath = null;
      this.value.error = errorMessage(error);
      if (startedLog) this.logCompletion(logger, sourceId);
    }
  }

  private requireSource(): Promise<ScanSource> {
    if (!this.input.createSource) throw new Error("Startup scan source is unavailable.");
    return this.input.createSource();
  }

  private requireImporter(source: ScanSource, signal: AbortSignal): ScanImporter {
    if (!this.input.createImporter) throw new Error("Startup scan importer is unavailable.");
    return this.input.createImporter(source, signal);
  }

  private async processCandidate(
    importer: ScanImporter,
    candidate: SourceCandidate,
    cycleId: string,
    signal: AbortSignal,
  ): Promise<SourceProcessResult> {
    try {
      return await importer.process(candidate, cycleId);
    } catch (error) {
      if (signal.aborted) throw error;
      return { outcome: "failed", error: errorMessage(error) };
    }
  }

  private countOutcome(result: SourceProcessResult): void {
    switch (result.outcome) {
      case "queued":
        this.value.counts.queued += 1;
        break;
      case "unchanged":
        this.value.counts.unchanged += 1;
        break;
      case "duplicate":
        this.value.counts.duplicates += 1;
        break;
      case "unsupported":
        this.value.counts.unsupported += 1;
        break;
      case "oversized":
        this.value.counts.oversized += 1;
        break;
      case "failed":
        this.value.counts.failed += 1;
        break;
    }
  }

  private logCompletion(logger: Pick<Console, "info" | "error">, sourceId?: string): void {
    const startedAt = this.value.startedAt ? Date.parse(this.value.startedAt) : Date.now();
    logger.info({
      event: "startup_scan_completed",
      ...(sourceId ? { sourceId } : {}),
      state: this.value.state,
      durationMs: Math.max(0, Date.now() - startedAt),
      counts: { ...this.value.counts },
      limitReached: this.value.limitReached,
    });
  }
}
