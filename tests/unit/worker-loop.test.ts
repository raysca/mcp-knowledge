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

describe("startWorkerLoop archive extraction", () => {
  test("claims and extracts a queued archive import before falling back to job claims", async () => {
    let archiveClaims = 0;
    let jobClaims = 0;
    let resolveExtracted!: () => void;
    const extracted = new Promise<void>((resolve) => { resolveExtracted = resolve; });
    const extractedIds: string[] = [];
    const repo = {
      async claimArchiveImport() {
        archiveClaims += 1;
        return archiveClaims === 1 ? { id: "arc_1" } : null;
      },
      async claimJob() {
        jobClaims += 1;
        return null;
      },
    } as unknown as KnowledgeRepository;
    const ingestion = { async process() {} } as unknown as IngestionService;
    const archives = {
      async extract(id: string) {
        extractedIds.push(id);
        resolveExtracted();
      },
    };

    const stop = startWorkerLoop({ repo, ingestion, archives, leaseMs: 60_000, ingestionTimeoutMs: 60_000 });
    try {
      await Promise.race([
        extracted,
        Bun.sleep(500).then(() => { throw new Error("archive was not extracted"); }),
      ]);
      expect(extractedIds).toEqual(["arc_1"]);
    } finally {
      stop();
    }
  });

  test("an extraction error does not crash the loop; it keeps claiming", async () => {
    let archiveClaims = 0;
    let jobClaims = 0;
    let resolveJobClaimed!: () => void;
    const jobClaimed = new Promise<void>((resolve) => { resolveJobClaimed = resolve; });
    const repo = {
      async claimArchiveImport() {
        archiveClaims += 1;
        return archiveClaims === 1 ? { id: "arc_1" } : null;
      },
      async claimJob() {
        jobClaims += 1;
        resolveJobClaimed();
        return null;
      },
    } as unknown as KnowledgeRepository;
    const ingestion = { async process() {} } as unknown as IngestionService;
    const archives = {
      async extract() {
        throw new Error("unexpected extraction failure");
      },
    };

    const stop = startWorkerLoop({ repo, ingestion, archives, leaseMs: 60_000, ingestionTimeoutMs: 60_000 });
    try {
      await Promise.race([
        jobClaimed,
        Bun.sleep(500).then(() => { throw new Error("loop stalled after extraction error"); }),
      ]);
      expect(jobClaims).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test("logs claim/extraction failures as single JSON lines", async () => {
    let claims = 0;
    let resolveLogged!: () => void;
    const logged = new Promise<void>((resolve) => { resolveLogged = resolve; });
    const original = console.error;
    let captured = "";
    console.error = ((line: string) => {
      captured = line;
      resolveLogged();
    }) as typeof console.error;

    const repo = {
      async claimArchiveImport() {
        claims += 1;
        throw new Error("archive claim exploded");
      },
      async claimJob() {
        return null;
      },
    } as unknown as KnowledgeRepository;
    const ingestion = { async process() {} } as unknown as IngestionService;
    const archives = { async extract() {} };

    const stop = startWorkerLoop({ repo, ingestion, archives, leaseMs: 60_000, ingestionTimeoutMs: 60_000 });
    try {
      await Promise.race([
        logged,
        Bun.sleep(500).then(() => { throw new Error("claim failure was not logged"); }),
      ]);
      const record = JSON.parse(captured);
      expect(record.level).toBe("error");
      expect(record.event).toBe("worker_archive_claim_failed");
      expect(record.error.message).toBe("archive claim exploded");
    } finally {
      stop();
      console.error = original;
    }
  });
});
