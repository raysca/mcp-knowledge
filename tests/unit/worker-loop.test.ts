import { describe, expect, test } from "bun:test";
import type {
  IngestionJob, IngestionService, KnowledgeRepository,
} from "../../packages/core/src/index.ts";
import { startWorkerLoop } from "../../apps/server/src/workers/loop.ts";

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
});
