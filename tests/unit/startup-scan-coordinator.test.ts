import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceFileRecord, SourceScanCycle } from "../../packages/core/src/index.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";
import {
  StartupIngestionCoordinator,
  type StartupScanStatus,
} from "../../apps/server/src/startup-scan/coordinator.ts";

type Candidate = { relativePath: string };

type Source = {
  sourceId: string;
  configurationFingerprint: string;
  candidates(signal: AbortSignal): AsyncIterable<Candidate>;
  inspectAndRead(
    candidate: Candidate,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string }>;
  pathState(relativePath: string): Promise<"present" | "missing" | "unknown">;
};

type Importer = {
  process(candidate: Candidate, scanCycle: string): Promise<{
    outcome: "queued" | "unchanged" | "duplicate" | "unsupported" | "oversized" | "failed";
    error?: string;
  }>;
};

type LoggerCall = { method: "info" | "error"; payload: unknown };

class FakeRepository {
  opened: Array<{
    sourceId: string;
    configurationFingerprint: string;
    proposedCycleId: string;
  }> = [];
  completed: Array<{ sourceId: string; cycleId: string; limitReached: boolean }> = [];
  sourceFiles = new Map<string, SourceFileRecord>();
  cycle: SourceScanCycle = { cycleId: "cycle-new", resumed: false };

  async openSourceScan(input: {
    sourceId: string;
    configurationFingerprint: string;
    proposedCycleId: string;
  }): Promise<SourceScanCycle> {
    this.opened.push(input);
    return this.cycle;
  }

  async getSourceFile(_sourceId: string, relativePath: string): Promise<SourceFileRecord | null> {
    return this.sourceFiles.get(relativePath) ?? null;
  }

  async completeSourceScan(input: {
    sourceId: string;
    cycleId: string;
    limitReached: boolean;
  }): Promise<void> {
    this.completed.push(input);
  }
}

function source(paths: string[], options: { error?: Error } = {}): Source {
  return {
    sourceId: "source-opaque",
    configurationFingerprint: "fingerprint-opaque",
    async *candidates(signal: AbortSignal) {
      for (const relativePath of paths) {
        if (signal.aborted) throw signal.reason;
        yield { relativePath };
      }
      if (options.error) throw options.error;
    },
    async inspectAndRead(_candidate, _maxBytes, _signal) {
      return { bytes: new Uint8Array(), sizeBytes: 0, sha256: "unused" };
    },
    async pathState(_relativePath) {
      return "present";
    },
  };
}

function importer(
  outcomes: Record<string, Importer["process"] extends never ? never : Awaited<ReturnType<Importer["process"]>>>,
): Importer & { processed: Candidate[] } {
  const processed: Candidate[] = [];
  return {
    processed,
    async process(candidate) {
      processed.push(candidate);
      return outcomes[candidate.relativePath] ?? { outcome: "queued" };
    },
  };
}

function processedCandidates(scanImporter: Importer): Candidate[] {
  return (scanImporter as Importer & { processed?: Candidate[] }).processed ?? [];
}

function setup(input: {
  paths?: string[];
  maxFiles?: number;
  disabledReason?: StartupScanStatus["disabledReason"];
  source?: Source;
  createSource?: () => Promise<Source>;
  importer?: Importer;
} = {}) {
  const repo = new FakeRepository();
  const calls: LoggerCall[] = [];
  const scanSource = input.source ?? source(input.paths ?? []);
  const scanImporter = input.importer ?? importer({});
  const coordinator = new StartupIngestionCoordinator({
    repo,
    maxFiles: input.maxFiles ?? 10,
    disabledReason: input.disabledReason ?? undefined,
    createSource: input.createSource ?? (async () => scanSource),
    createImporter: () => scanImporter,
    logger: {
      info: (payload: unknown) => calls.push({ method: "info", payload }),
      error: (payload: unknown) => calls.push({ method: "error", payload }),
    },
  });
  return { coordinator, repo, calls, scanImporter };
}

async function waitForTerminal(coordinator: StartupIngestionCoordinator): Promise<StartupScanStatus> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = coordinator.status();
    if (status.state !== "scanning") return status;
    await Bun.sleep(1);
  }
  throw new Error("startup scan did not reach a terminal state");
}

function recorded(relativePath: string, scanCycle: string): SourceFileRecord {
  const now = new Date("2026-08-31T00:00:00.000Z");
  return {
    sourceId: "source-opaque",
    relativePath,
    lastOutcome: "unchanged",
    scanCycle,
    createdAt: now,
    updatedAt: now,
  };
}

describe("StartupIngestionCoordinator", () => {
  test("createApp defers configured-root creation until startup is explicitly requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-startup-scan-app-"));
    let sourceCreations = 0;
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      app = await createApp(
        loadEnv({
          DATABASE_URL: `file:${join(dir, "app.db")}`,
          STORAGE_PATH: join(dir, "blobs"),
          INGEST_DATA_DIR: "/private/source-root",
        }),
        {
          createDirectorySource: async () => {
            sourceCreations += 1;
            throw new Error("configured root cannot be read");
          },
        },
      );

      expect(sourceCreations).toBe(0);
      app.startStartupScan();
      for (let attempt = 0; attempt < 100 && sourceCreations === 0; attempt += 1) {
        await Bun.sleep(1);
      }
      expect(sourceCreations).toBe(1);
    } finally {
      app?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["not configured", "not_configured"],
    ["unsupported profile", "unsupported_profile"],
    ["unsupported role", "unsupported_role"],
  ] as const)("reports disabled when %s", async (_description, disabledReason) => {
    const { coordinator, repo } = setup({ disabledReason });

    coordinator.start();
    await Bun.sleep(1);

    expect(coordinator.status()).toEqual({
      state: "disabled",
      startedAt: null,
      completedAt: null,
      currentPath: null,
      counts: {
        discovered: 0,
        examined: 0,
        queued: 0,
        unchanged: 0,
        duplicates: 0,
        unsupported: 0,
        oversized: 0,
        failed: 0,
      },
      limitReached: false,
      error: null,
      disabledReason,
    });
    expect(repo.opened).toEqual([]);
  });

  test("returns immutable status snapshots", () => {
    const { coordinator } = setup({ disabledReason: "not_configured" });

    const snapshot = coordinator.status();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.counts)).toBe(true);
    expect(coordinator.status().counts.queued).toBe(0);
  });

  test("completes once with counters for each successful classification", async () => {
    const scanImporter = importer({
      "queued.txt": { outcome: "queued" },
      "same.txt": { outcome: "unchanged" },
      "copy.txt": { outcome: "duplicate" },
      "unsupported.exe": { outcome: "unsupported" },
      "large.pdf": { outcome: "oversized" },
    });
    const { coordinator, repo } = setup({
      paths: ["queued.txt", "same.txt", "copy.txt", "unsupported.exe", "large.pdf"],
      importer: scanImporter,
    });

    coordinator.start();
    coordinator.start();
    const status = await waitForTerminal(coordinator);

    expect(status).toEqual(
      expect.objectContaining({
        state: "completed",
        currentPath: null,
        limitReached: false,
        error: null,
        disabledReason: null,
        counts: {
          discovered: 5,
          examined: 5,
          queued: 1,
          unchanged: 1,
          duplicates: 1,
          unsupported: 1,
          oversized: 1,
          failed: 0,
        },
      }),
    );
    expect(status.startedAt).toEqual(expect.any(String));
    expect(status.completedAt).toEqual(expect.any(String));
    expect(repo.opened).toHaveLength(1);
    expect(repo.completed).toEqual([
      { sourceId: "source-opaque", cycleId: "cycle-new", limitReached: false },
    ]);
    expect(processedCandidates(scanImporter).map((candidate) => candidate.relativePath)).toEqual([
      "queued.txt",
      "same.txt",
      "copy.txt",
      "unsupported.exe",
      "large.pdf",
    ]);
  });

  test("finishes with errors and writes a sanitized structured log pair", async () => {
    const absoluteRoot = "/private/source-root";
    const scanImporter = importer({
      "bad.txt": { outcome: "failed", error: `read failed below ${absoluteRoot}` },
      "good.txt": { outcome: "queued" },
    });
    const { coordinator, calls } = setup({
      paths: ["bad.txt", "good.txt"],
      importer: scanImporter,
    });

    coordinator.start();
    const status = await waitForTerminal(coordinator);

    expect(status).toEqual(
      expect.objectContaining({
        state: "completed_with_errors",
        currentPath: null,
        counts: expect.objectContaining({ failed: 1, queued: 1 }),
      }),
    );
    expect(calls.filter((call) => call.method === "info")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ event: "startup_scan_started" }) }),
      expect.objectContaining({
        payload: expect.objectContaining({
          event: "startup_scan_completed",
          counts: expect.objectContaining({ failed: 1, queued: 1 }),
          limitReached: false,
        }),
      }),
    ]);
    expect(calls.filter((call) => call.method === "error")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          event: "startup_scan_file_failed",
          relativePath: "bad.txt",
          outcome: "failed",
          errorCode: "SOURCE_FILE_FAILED",
          errorMessage: expect.any(String),
        }),
      }),
    ]);
    expect(JSON.stringify(calls)).not.toContain(absoluteRoot);
    expect(JSON.stringify(calls)).not.toContain("bytes");
  });

  test("leaves an active cycle unfinished after fatal discovery fails", async () => {
    const absoluteRoot = "/private/source-root";
    const { coordinator, repo } = setup({
      source: source([], { error: new Error(`cannot read ${absoluteRoot} or /root`) }),
    });

    coordinator.start();
    const status = await waitForTerminal(coordinator);

    expect(status).toEqual(
      expect.objectContaining({
        state: "failed",
        currentPath: null,
        completedAt: expect.any(String),
      }),
    );
    expect(status.error).not.toContain(absoluteRoot);
    expect(status.error).not.toContain("/root");
    expect(repo.completed).toEqual([]);
  });

  test("redacts real paths but preserves non-path diagnostics like mime types", async () => {
    const absoluteRoot = "/private/source-root";
    const { coordinator } = setup({
      source: source([], {
        error: new Error(
          `Unsupported mime type: application/x-foo while reading ${absoluteRoot}/bad.bin`,
        ),
      }),
    });

    coordinator.start();
    const status = await waitForTerminal(coordinator);

    expect(status.error).toContain("Unsupported mime type: application/x-foo");
    expect(status.error).not.toContain(absoluteRoot);
  });

  test("logs a structured start and end pair when source creation fails", async () => {
    const absoluteRoot = "/private/source-root";
    const { coordinator, calls } = setup({
      createSource: async () => {
        throw new Error(`cannot create ${absoluteRoot}`);
      },
    });

    coordinator.start();
    const status = await waitForTerminal(coordinator);

    expect(status).toEqual(expect.objectContaining({ state: "failed", currentPath: null }));
    expect(calls.filter((call) => call.method === "info")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ event: "startup_scan_started" }) }),
      expect.objectContaining({
        payload: expect.objectContaining({
          event: "startup_scan_completed",
          state: "failed",
          counts: {
            discovered: 0,
            examined: 0,
            queued: 0,
            unchanged: 0,
            duplicates: 0,
            unsupported: 0,
            oversized: 0,
            failed: 0,
          },
        }),
      }),
    ]);
    expect(JSON.stringify(calls)).not.toContain(absoluteRoot);
  });

  test("processes exactly maxFiles newly examined entries before completing the active cycle", async () => {
    const { coordinator, repo, scanImporter } = setup({
      paths: ["first.txt", "second.txt", "third.txt"],
      maxFiles: 2,
    });

    coordinator.start();
    const status = await waitForTerminal(coordinator);

    expect(status).toEqual(
      expect.objectContaining({
        state: "completed",
        limitReached: true,
        counts: expect.objectContaining({ discovered: 3, examined: 2, queued: 2 }),
      }),
    );
    expect(processedCandidates(scanImporter).map((candidate) => candidate.relativePath)).toEqual([
      "first.txt",
      "second.txt",
    ]);
    expect(repo.completed).toEqual([
      { sourceId: "source-opaque", cycleId: "cycle-new", limitReached: true },
    ]);
  });

  test("skips entries already marked with the resumed active cycle", async () => {
    const { coordinator, repo, scanImporter } = setup({
      paths: ["already-done.txt", "remaining.txt"],
      maxFiles: 1,
    });
    repo.cycle = { cycleId: "cycle-resumed", resumed: true };
    repo.sourceFiles.set("already-done.txt", recorded("already-done.txt", "cycle-resumed"));

    coordinator.start();
    const status = await waitForTerminal(coordinator);

    expect(status.counts).toEqual({
      discovered: 2,
      examined: 1,
      queued: 1,
      unchanged: 0,
      duplicates: 0,
      unsupported: 0,
      oversized: 0,
      failed: 0,
    });
    expect(status.limitReached).toBe(false);
    expect(processedCandidates(scanImporter).map((candidate) => candidate.relativePath)).toEqual([
      "remaining.txt",
    ]);
  });

  test("aborts without completing the active cycle", async () => {
    let started: (() => void) | undefined;
    const scanImporter: Importer = {
      process: async () =>
        new Promise((resolve, reject) => {
          started = () => reject(new DOMException("stopped", "AbortError"));
        }),
    };
    const { coordinator, repo } = setup({ paths: ["in-flight.txt"], importer: scanImporter });

    coordinator.start();
    for (let attempt = 0; attempt < 100 && !started; attempt += 1) await Bun.sleep(1);
    expect(started).toEqual(expect.any(Function));

    coordinator.stop();
    started?.();
    await Bun.sleep(1);

    expect(repo.completed).toEqual([]);
    expect(coordinator.status()).toEqual(
      expect.objectContaining({ state: "scanning", completedAt: null, error: null }),
    );
  });
});
