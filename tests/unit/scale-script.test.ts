import { describe, expect, test } from "bun:test";
import {
  generateScaleDocument,
  parseScaleArguments,
  parseDockerByteSize,
  percentile,
  serializeScaleReport,
  validateScaleReport,
  type ScaleReport,
} from "../../scripts/scale/lib.ts";
import { runScale, type ScaleRuntime } from "../../scripts/scale/run.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("scale script helpers", () => {
  test.each([[[]], [["--documents", "99", "--output", "report.json"]], [["--documents", "100"]], [["--documents", "100", "--output", ""]]])(
    "rejects unsupported or incomplete arguments: %p",
    (args) => {
      expect(() => parseScaleArguments(args, () => false)).toThrow();
    },
  );

  test("rejects an existing report instead of overwriting it", () => {
    expect(() => parseScaleArguments(["--documents", "500", "--output", "existing.json"], () => true)).toThrow(
      "already exists",
    );
  });

  test("accepts each supported document count and a new output path", () => {
    expect(parseScaleArguments(["--documents", "100", "--output", "new.json"], () => false)).toEqual({
      documents: 100,
      outputPath: "new.json",
    });
    expect(parseScaleArguments(["--documents", "500", "--output", "new.json"], () => false).documents).toBe(500);
    expect(parseScaleArguments(["--documents", "1000", "--output", "new.json"], () => false).documents).toBe(1000);
  });

  test("generates deterministic, unique fixtures and exact queries", () => {
    expect(generateScaleDocument(1)).toEqual({
      filename: "local-rag-0001.txt",
      body:
        "Local RAG scale fixture 0001. Reference identifier LOCAL-RAG-0001. This record exists only for deterministic local retrieval measurement.\n",
      query: "LOCAL-RAG-0001",
      identifier: "LOCAL-RAG-0001",
    });
    expect(generateScaleDocument(1)).toEqual(generateScaleDocument(1));
    expect(generateScaleDocument(2).identifier).toBe("LOCAL-RAG-0002");
    expect(generateScaleDocument(2).body).not.toBe(generateScaleDocument(1).body);
  });

  test("calculates nearest-rank percentiles from sorted copies", () => {
    const samples = [50, 10, 40, 20, 30];
    expect(percentile(samples, 0.5)).toBe(30);
    expect(percentile(samples, 0.95)).toBe(50);
    expect(samples).toEqual([50, 10, 40, 20, 30]);
    expect(() => percentile([], 0.5)).toThrow("at least one sample");
  });

  test("converts Docker memory units to bytes", () => {
    expect(parseDockerByteSize("512KiB")).toBe(524288);
    expect(parseDockerByteSize("1.5MiB")).toBe(1572864);
    expect(parseDockerByteSize("2GiB")).toBe(2147483648);
  });

  test("serializes metrics without fixture bodies, queries, or document identifiers", () => {
    const report: ScaleReport = {
      schemaVersion: 1,
      documents: 100,
      environment: {
        capturedAtUtc: "2026-09-05T12:00:00.000Z",
        dockerVersion: "29.4.0",
        hostArchitecture: "arm64",
        cpuModel: "Apple M4 Pro",
        cpuCount: 10,
        totalMemoryBytes: 17179869184,
        imageReference: "mcp-knowledge-scale:test",
        imageDigest: "sha256:abc",
        commit: "0123456789abcdef",
      },
      ingestion: { totalMs: 1200, perDocumentMs: 12 },
      resources: { peakRssBytes: 268435456, storageBytes: 1048576 },
      search: {
        sampleSize: 100,
        coldMs: { p50: 8, p95: 15 },
        warmMs: { p50: 5, p95: 9 },
      },
      restart: { healthReadyMs: 400, searchReadyMs: 420 },
    };

    const serialized = serializeScaleReport(report);
    expect(JSON.parse(serialized)).toEqual(report);
    expect(serialized).not.toContain("Local RAG scale fixture");
    expect(serialized).not.toContain("LOCAL-RAG-");
    expect(serialized).not.toContain('"body"');
    expect(serialized).not.toContain('"query"');
  });

  test("rejects content-bearing or internally inconsistent reports", () => {
    const valid = JSON.parse(
      serializeScaleReport({
        schemaVersion: 1,
        documents: 100,
        environment: {
          capturedAtUtc: "2026-09-05T12:00:00.000Z",
          dockerVersion: "29.4.0",
          hostArchitecture: "arm64",
          cpuModel: "Apple M4 Pro",
          cpuCount: 10,
          totalMemoryBytes: 17179869184,
          imageReference: "mcp-knowledge-scale:test",
          imageDigest: "sha256:abc",
          commit: "0123456789abcdef",
        },
        ingestion: { totalMs: 1200, perDocumentMs: 12 },
        resources: { peakRssBytes: 268435456, storageBytes: 1048576 },
        search: {
          sampleSize: 100,
          coldMs: { p50: 8, p95: 15 },
          warmMs: { p50: 5, p95: 9 },
        },
        restart: { healthReadyMs: 400, searchReadyMs: 420 },
      }),
    );
    expect(() => validateScaleReport(valid)).not.toThrow();
    expect(() => validateScaleReport({ ...valid, body: "private document body" })).toThrow("unexpected fields");
    expect(() => validateScaleReport({ ...valid, search: { ...valid.search, sampleSize: 99 } })).toThrow(
      "sample size",
    );
  });
});

describe("scale runner", () => {
  function runtime(input: { existingDocuments?: unknown[] } = {}) {
    let clock = 0;
    let activeUpload: string | undefined;
    let restarted = false;
    const events: string[] = [];
    const fake: ScaleRuntime = {
      baseUrl: "http://127.0.0.1:3000",
      containerName: "scale-test-container",
      fetch: async (request, init) => {
        const url = String(request);
        if (restarted && !url.startsWith("http://127.0.0.1:40000/")) {
          throw new Error("The runner used its stale pre-restart port.");
        }
        if (url.endsWith("/api/v1/documents") && (!init?.method || init.method === "GET")) {
          events.push("list");
          return Response.json({ items: input.existingDocuments ?? [] });
        }
        if (url.endsWith("/api/v1/documents") && init?.method === "POST") {
          const form = init.body as FormData;
          const file = form.get("file") as File;
          activeUpload = file.name.replace("local-rag-", "doc-").replace(".txt", "");
          events.push(`upload:${file.name}`);
          return Response.json({ id: activeUpload, status: "queued", duplicate: false }, { status: 202 });
        }
        if (url.endsWith("/api/v1/search") && init?.method === "POST") {
          const query = String((JSON.parse(String(init.body)) as { query: string }).query);
          const sequence = query.slice(-4);
          return Response.json({ hits: [{ documentId: `doc-${sequence}` }] });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
      waitForHealth: async (targetBaseUrl) => {
        const healthBaseUrl = targetBaseUrl ?? "http://127.0.0.1:3000";
        if (restarted && healthBaseUrl !== "http://127.0.0.1:40000") {
          throw new Error("The runner waited on its stale pre-restart port.");
        }
        events.push(`health:${healthBaseUrl}`);
      },
      resolveBaseUrl: async () => {
        events.push("resolve-port");
        return "http://127.0.0.1:40000";
      },
      waitForDocument: async (id) => {
        if (id !== activeUpload) throw new Error(`Readiness was not awaited for the active upload: ${id}`);
        events.push(`ready:${id}`);
        return { id, status: "ready" };
      },
      runCommand: async (args) => {
        const command = args.join(" ");
        if (command.includes("docker version")) return "29.4.0\n";
        if (command.includes(".Config.Image")) return "mcp-knowledge-scale:test\n";
        if (command.includes(".Image")) return "sha256:abc\n";
        if (command.includes("git rev-parse")) return "0123456789abcdef\n";
        if (command.includes("docker stats")) return "256MiB\n";
        if (command.includes("du -sk")) return "1024\t/app/data\n";
        if (command.includes("docker restart")) {
          restarted = true;
          events.push("restart");
          return "scale-test-container\n";
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      now: () => (clock += 10),
      capturedAtUtc: () => "2026-09-05T12:00:00.000Z",
      hostArchitecture: "arm64",
      cpuModel: "Apple M4 Pro",
      cpuCount: 10,
      totalMemoryBytes: 17179869184,
    };
    return { fake, events };
  }

  test("refuses to run against a non-empty corpus", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-knowledge-scale-test-"));
    try {
      const { fake } = runtime({ existingDocuments: [{ id: "user-document" }] });
      await expect(runScale({ documents: 100, outputPath: join(directory, "report.json") }, fake)).rejects.toThrow(
        "empty corpus",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("measures a sequential run and writes only content-free aggregate metrics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-knowledge-scale-test-"));
    const outputPath = join(directory, "report.json");
    try {
      const { fake, events } = runtime();
      const report = await runScale({ documents: 100, outputPath }, fake);
      expect(report.documents).toBe(100);
      expect(report.ingestion).toEqual({ totalMs: 10, perDocumentMs: 0.1 });
      expect(report.resources).toEqual({ peakRssBytes: 268435456, storageBytes: 1048576 });
      expect(report.search).toEqual({
        sampleSize: 100,
        coldMs: { p50: 10, p95: 10 },
        warmMs: { p50: 10, p95: 10 },
      });
      expect(report.restart).toEqual({ healthReadyMs: 10, searchReadyMs: 20 });
      expect(events.slice(0, 5)).toEqual([
        "health:http://127.0.0.1:3000",
        "list",
        "upload:local-rag-0001.txt",
        "ready:doc-0001",
        "upload:local-rag-0002.txt",
      ]);
      expect(events.slice(-3)).toEqual(["restart", "resolve-port", "health:http://127.0.0.1:40000"]);
      const serialized = await readFile(outputPath, "utf8");
      expect(JSON.parse(serialized)).toEqual(report);
      expect(serialized).not.toContain("LOCAL-RAG-");
      expect(serialized).not.toContain("Local RAG scale fixture");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
