import { describe, expect, test } from "bun:test";
import type {
  AppError, IngestionJob, IngestionService, KnowledgeRepository,
} from "../../packages/core/src/index.ts";
import { startWorkerLoop } from "../../apps/server/src/workers/loop.ts";
import { parseIngestionError } from "../../apps/server/src/ui/lib/ingestion-error.ts";

function job(): IngestionJob {
  const now = new Date();
  return {
    id: "job_vanished",
    documentId: "doc_1",
    revisionId: "rev_1",
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
  };
}

describe("startWorkerLoop", () => {
  test("persists the same safe failure for the job and document", async () => {
    let persistedJobError = "";
    let persistedDocumentError = "";
    let resolvePersisted!: () => void;
    const persisted = new Promise<void>((resolve) => { resolvePersisted = resolve; });
    let claims = 0;
    const repo = {
      async claimJob() {
        claims += 1;
        return claims === 1 ? job() : null;
      },
      async failJob(_id: string, error: Error) {
        persistedJobError = error.message;
        return { ...job(), status: "failed" as const, error: error.message };
      },
      async setDocumentStatus(_id: string, _status: string, error: string) {
        persistedDocumentError = error;
        resolvePersisted();
      },
    } as unknown as KnowledgeRepository;
    const ingestion = {
      async process() {
        const error = new Error("parser read /Users/private/secret.pdf token super-secret-token");
        (error as AppError & { code: string }).code = "UNTRUSTED_PARSER_FAILURE";
        throw error;
      },
    } as unknown as IngestionService;

    const stop = startWorkerLoop({ repo, ingestion, leaseMs: 60_000, ingestionTimeoutMs: 60_000 });
    try {
      await Promise.race([persisted, Bun.sleep(500).then(() => { throw new Error("failure was not persisted"); })]);
      expect(persistedJobError).toBe("DOCUMENT_MALFORMED: This document could not be parsed.");
      expect(persistedDocumentError).toBe(persistedJobError);
      expect(persistedJobError).not.toContain("/Users/private/secret.pdf");
      expect(persistedDocumentError).not.toContain("super-secret-token");
    } finally {
      stop();
    }
  });

  test("persists the public timeout code and retry-once action from the real timeout branch", async () => {
    let persistedJobError = "";
    let persistedDocumentError = "";
    let resolvePersisted!: () => void;
    const persisted = new Promise<void>((resolve) => { resolvePersisted = resolve; });
    let claims = 0;
    const repo = {
      async claimJob() {
        claims += 1;
        return claims === 1 ? job() : null;
      },
      async failJob(_id: string, error: Error) {
        persistedJobError = error.message;
        return { ...job(), status: "failed" as const, error: error.message };
      },
      async setDocumentStatus(_id: string, _status: string, error: string) {
        persistedDocumentError = error;
        resolvePersisted();
      },
    } as unknown as KnowledgeRepository;
    const ingestion = {
      async process() {
        return new Promise<void>(() => {});
      },
    } as unknown as IngestionService;

    const stop = startWorkerLoop({ repo, ingestion, leaseMs: 60_000, ingestionTimeoutMs: 1 });
    try {
      await Promise.race([persisted, Bun.sleep(500).then(() => { throw new Error("timeout was not persisted"); })]);
      expect(persistedJobError).toBe("INGESTION_TIMEOUT: Ingestion timed out.");
      expect(persistedDocumentError).toBe(persistedJobError);
      expect(parseIngestionError(persistedJobError)).toEqual({
        code: "INGESTION_TIMEOUT",
        message: "Ingestion timed out.",
        action: "Retry once. If it fails again, check Jobs and troubleshooting.",
      });
    } finally {
      stop();
    }
  });

  test("keeps claiming after failJob throws", async () => {
    let claims = 0;
    let resolveSecond!: () => void;
    const sawSecondClaim = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });

    const repo = {
      async claimJob() {
        claims += 1;
        if (claims === 1) return job();
        if (claims === 2) resolveSecond();
        return null;
      },
      async failJob() {
        throw new Error("JOB_NOT_FOUND");
      },
      async setDocumentStatus() {},
    } as unknown as KnowledgeRepository;

    const ingestion = {
      async process() {
        throw new Error("parse failed");
      },
    } as unknown as IngestionService;

    const stop = startWorkerLoop({
      repo,
      ingestion,
      leaseMs: 60_000,
      ingestionTimeoutMs: 60_000,
    });

    try {
      await Promise.race([
        sawSecondClaim,
        Bun.sleep(500).then(() => {
          throw new Error("loop died: never claimed again after failJob");
        }),
      ]);
      expect(claims).toBeGreaterThanOrEqual(2);
    } finally {
      stop();
    }
  });

  test("does not persist a late ingestion rejection after stop", async () => {
    let claims = 0;
    let failCalls = 0;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let rejectProcess!: (error: Error) => void;
    const repo = {
      async claimJob() {
        claims += 1;
        return claims === 1 ? job() : null;
      },
      async failJob() {
        failCalls += 1;
        return { ...job(), status: "failed" as const };
      },
      async setDocumentStatus() {},
    } as unknown as KnowledgeRepository;
    const ingestion = {
      async process() {
        resolveStarted();
        return new Promise<void>((_resolve, reject) => {
          rejectProcess = reject;
        });
      },
    } as unknown as IngestionService;

    const stop = startWorkerLoop({ repo, ingestion, leaseMs: 60_000, ingestionTimeoutMs: 60_000 });
    await started;
    stop();
    rejectProcess(new Error("late parser failure"));
    await Bun.sleep(20);

    expect(failCalls).toBe(0);
  });
});
