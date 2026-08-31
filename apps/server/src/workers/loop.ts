import { errorCodeOf, type IngestionService } from "@mcp-knowledge/core";
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
            if (!finished) throw new Error("INGESTION_TIMEOUT");
          }),
        ]);
      } catch (error) {
        try {
          const failed = await input.repo.failJob(job.id, error instanceof Error ? error : new Error(String(error)));
          const code = errorCodeOf(error);
          const message = error instanceof Error ? error.message : String(error);
          await input.repo.setDocumentStatus(
            job.documentId,
            failed.status === "failed" ? "failed" : "processing",
            `${code}: ${message}`.slice(0, 2000),
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
