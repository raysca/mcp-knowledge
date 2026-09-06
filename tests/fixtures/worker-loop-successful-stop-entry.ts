import type { IngestionJob, IngestionService, KnowledgeRepository } from "../../packages/core/src/index.ts";
import { startWorkerLoop } from "../../apps/server/src/workers/loop.ts";

const now = new Date();
const queuedJob: IngestionJob = {
  id: "job_shutdown",
  documentId: "doc_shutdown",
  revisionId: "rev_shutdown",
  status: "running",
  attempt: 1,
  maxAttempts: 3,
  createdAt: now,
  updatedAt: now,
};

const scenario = process.argv[2] ?? "success";

if (scenario === "claim-race") {
  let resolveClaim!: (job: IngestionJob) => void;
  let resolveClaimStarted!: () => void;
  const claimStarted = new Promise<void>((resolve) => {
    resolveClaimStarted = resolve;
  });
  const repo = {
    async claimJob() {
      resolveClaimStarted();
      return new Promise<IngestionJob>((resolve) => {
        resolveClaim = resolve;
      });
    },
  } as unknown as KnowledgeRepository;
  const ingestion = {
    async process() {
      process.stdout.write("processed\n");
    },
  } as unknown as IngestionService;
  const stop = startWorkerLoop({ repo, ingestion, leaseMs: 60_000, ingestionTimeoutMs: 60_000 });
  await claimStarted;
  stop();
  resolveClaim(queuedJob);
  await Bun.sleep(10);
  process.stdout.write("done\n");
} else {
  let claims = 0;
  const repo = {
    async claimJob() {
      claims += 1;
      return claims === 1 ? queuedJob : null;
    },
    async failJob(_id: string, error: Error) {
      return { ...queuedJob, status: "failed" as const, error: error.message };
    },
    async setDocumentStatus() {
      resolveSettled();
    },
  } as unknown as KnowledgeRepository;

  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const ingestion = {
    async process() {
      if (scenario === "failure") throw new Error("parse failed");
      resolveSettled();
      if (scenario === "in-flight-stop") return new Promise<void>(() => {});
    },
  } as unknown as IngestionService;

  const stop = startWorkerLoop({ repo, ingestion, leaseMs: 60_000, ingestionTimeoutMs: 60_000 });
  await settled;
  await Bun.sleep(0);
  stop();
  process.stdout.write("done\n");
}
