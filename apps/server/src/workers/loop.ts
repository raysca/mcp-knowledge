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
      if (!job) {
        await Bun.sleep(250);
        continue;
      }
      try {
        let finished = false;
        await Promise.race([
          input.ingestion.process(job).finally(() => {
            finished = true;
          }),
          Bun.sleep(input.ingestionTimeoutMs).then(() => {
            if (!finished) throw new AppError("INGESTION_TIMEOUT", "ingestion timed out");
          }),
        ]);
      } catch (error) {
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
    stopped = true;
  };
}
