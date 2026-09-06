import { AppError, publicIngestionFailure, type IngestionService } from "@mcp-knowledge/core";
import type { KnowledgeRepository } from "@mcp-knowledge/core";
import { newId } from "@mcp-knowledge/core";

export function startWorkerLoop(input: {
  repo: KnowledgeRepository;
  ingestion: IngestionService;
  leaseMs: number;
  ingestionTimeoutMs: number;
}): () => void {
  const workerId = newId("job").replace("job_", "wkr_");
  let stopped = false;
  let activeTimeout: ReturnType<typeof setTimeout> | undefined;
  let activeOperation: AbortController | undefined;
  let resolveStopped!: (value: "stopped") => void;
  const stopRequested = new Promise<"stopped">((resolve) => {
    resolveStopped = resolve;
  });

  async function tick() {
    while (!stopped) {
      let job;
      try {
        job = await input.repo.claimJob(workerId, input.leaseMs);
      } catch (error) {
        console.error("worker loop: claimJob failed", error);
        await Bun.sleep(250);
        continue;
      }
      if (stopped) break;
      if (!job) {
        await Bun.sleep(250);
        continue;
      }
      try {
        const operation = new AbortController();
        activeOperation = operation;
        let timeout!: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            if (activeTimeout === timeout) activeTimeout = undefined;
            const error = new AppError("INGESTION_TIMEOUT", "ingestion timed out");
            reject(error);
            operation.abort(error);
          }, input.ingestionTimeoutMs);
          activeTimeout = timeout;
        });
        try {
          const result = await Promise.race([
            input.ingestion.process(job, operation.signal).then(() => "completed" as const),
            deadline,
            stopRequested,
          ]);
          if (result === "stopped") break;
        } finally {
          clearTimeout(timeout);
          if (activeTimeout === timeout) activeTimeout = undefined;
          if (activeOperation === operation) activeOperation = undefined;
        }
      } catch (error) {
        if (stopped) break;
        try {
          const failure = publicIngestionFailure(error);
          const publicError = new Error(`${failure.code}: ${failure.message}`);
          const failed = await input.repo.failJob(job.id, publicError);
          await input.repo.setDocumentStatus(
            job.documentId,
            failed.status === "failed" ? "failed" : "processing",
            publicError.message,
          );
        } catch {
          // job vanished (purge mid-flight); keep claiming
        }
      }
    }
  }

  void tick();
  return () => {
    if (stopped) return;
    stopped = true;
    resolveStopped("stopped");
    if (activeTimeout !== undefined) {
      clearTimeout(activeTimeout);
      activeTimeout = undefined;
    }
    activeOperation?.abort(new DOMException("Worker loop stopped.", "AbortError"));
  };
}
