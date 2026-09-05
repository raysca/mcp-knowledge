import { cpus, arch, totalmem } from "node:os";
import { writeFile } from "node:fs/promises";
import {
  generateScaleDocument,
  parseDockerByteSize,
  parseScaleArguments,
  percentile,
  serializeScaleReport,
  type ScaleArguments,
  type ScaleReport,
} from "./lib.ts";
import { waitForDocument, waitForHealth } from "../release/http.ts";

type ScaleFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ScaleRuntime = {
  baseUrl: string;
  containerName: string;
  fetch: ScaleFetch;
  waitForHealth: (baseUrl?: string) => Promise<void>;
  resolveBaseUrl: () => Promise<string>;
  waitForDocument: (id: string) => Promise<{ id: string; status: string }>;
  runCommand: (args: string[]) => Promise<string>;
  now: () => number;
  capturedAtUtc: () => string;
  hostArchitecture: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  headers?: HeadersInit;
};

type UploadResult = { id?: string; duplicate?: boolean };
type DocumentList = { items?: unknown[] };
type SearchResult = { hits?: Array<{ documentId?: string }> };

function endpoint(baseUrl: string, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

function rounded(value: number) {
  return Math.round(value * 1000) / 1000;
}

async function defaultRunCommand(args: string[]): Promise<string> {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(process.stdout).text();
  const status = await process.exited;
  if (status !== 0) throw new Error(`Command failed: ${args.slice(0, 2).join(" ")}`);
  return output;
}

function defaultRuntime(): ScaleRuntime {
  const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
  const containerName = process.env.SCALE_CONTAINER ?? "mcp-knowledge-scale";
  const apiKey = process.env.MCP_API_KEY;
  const headers: HeadersInit | undefined = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
  return {
    baseUrl,
    containerName,
    fetch: globalThis.fetch,
    waitForHealth: (targetBaseUrl = baseUrl) =>
      waitForHealth({ baseUrl: targetBaseUrl, requestInit: { headers }, timeoutMs: 120_000 }),
    resolveBaseUrl: async () => {
      const mapping = (await defaultRunCommand(["docker", "port", containerName, "3000/tcp"])).trim();
      const match = /^127\.0\.0\.1:([0-9]+)$/.exec(mapping);
      if (!match) throw new Error("Scale container port is not published on IPv4 loopback.");
      return `http://127.0.0.1:${match[1]}`;
    },
    waitForDocument: (id) => waitForDocument(id, { baseUrl, requestInit: { headers }, timeoutMs: 120_000 }),
    runCommand: defaultRunCommand,
    now: performance.now.bind(performance),
    capturedAtUtc: () => new Date().toISOString(),
    hostArchitecture: arch(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    headers,
  };
}

async function checkedJson<T>(runtime: ScaleRuntime, pathname: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(runtime.headers);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const response = await runtime.fetch(endpoint(runtime.baseUrl, pathname), { ...init, headers });
  if (!response.ok) throw new Error(`Request failed for ${pathname} (${response.status}).`);
  return (await response.json()) as T;
}

async function sampleRss(runtime: ScaleRuntime): Promise<number> {
  const output = await runtime.runCommand([
    "docker",
    "stats",
    "--no-stream",
    "--format",
    "{{.MemUsage}}",
    runtime.containerName,
  ]);
  return parseDockerByteSize(output.trim().split("/")[0]!.trim());
}

async function runSearch(runtime: ScaleRuntime, query: string, expectedDocumentId: string): Promise<number> {
  const started = runtime.now();
  const result = await checkedJson<SearchResult>(runtime, "/api/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, mode: "hybrid", limit: 5 }),
  });
  const elapsed = runtime.now() - started;
  if (!result.hits?.some((hit) => hit.documentId === expectedDocumentId)) {
    throw new Error("Search did not return the expected document.");
  }
  return elapsed;
}

export async function runScale(arguments_: ScaleArguments, runtime: ScaleRuntime = defaultRuntime()): Promise<ScaleReport> {
  await runtime.waitForHealth(runtime.baseUrl);
  const corpus = await checkedJson<DocumentList>(runtime, "/api/v1/documents");
  if (!Array.isArray(corpus.items) || corpus.items.length !== 0) {
    throw new Error("Scale measurement requires an empty corpus.");
  }

  const dockerVersion = (
    await runtime.runCommand(["docker", "version", "--format", "{{.Server.Version}}"])
  ).trim();
  const imageReference = (await runtime.runCommand([
    "docker",
    "inspect",
    "--format",
    "{{.Config.Image}}",
    runtime.containerName,
  ])).trim();
  const imageDigest = (await runtime.runCommand([
    "docker",
    "inspect",
    "--format",
    "{{.Image}}",
    runtime.containerName,
  ])).trim();
  const commit = (await runtime.runCommand(["git", "rev-parse", "HEAD"])).trim();

  let peakRssBytes = await sampleRss(runtime);
  const sampleEvery = Math.max(1, Math.floor(arguments_.documents / 20));
  const documentIds: string[] = [];
  const ingestionStarted = runtime.now();
  for (let index = 1; index <= arguments_.documents; index += 1) {
    const fixture = generateScaleDocument(index);
    const form = new FormData();
    form.set("file", new File([fixture.body], fixture.filename, { type: "text/plain" }));
    const upload = await checkedJson<UploadResult>(runtime, "/api/v1/documents", { method: "POST", body: form });
    if (!upload.id || upload.duplicate) throw new Error("Scale fixture upload was not uniquely accepted.");
    const ready = await runtime.waitForDocument(upload.id);
    if (ready.status !== "ready") throw new Error("Scale fixture did not become ready.");
    documentIds.push(upload.id);
    if (index % sampleEvery === 0 || index === arguments_.documents) {
      peakRssBytes = Math.max(peakRssBytes, await sampleRss(runtime));
      if (import.meta.main) console.log(`Ingested ${index}/${arguments_.documents} documents.`);
    }
  }
  const ingestionTotalMs = runtime.now() - ingestionStarted;

  const coldLatencies: number[] = [];
  for (let index = 1; index <= arguments_.documents; index += 1) {
    coldLatencies.push(await runSearch(runtime, generateScaleDocument(index).query, documentIds[index - 1]!));
  }
  const warmLatencies: number[] = [];
  for (let index = 1; index <= arguments_.documents; index += 1) {
    warmLatencies.push(await runSearch(runtime, generateScaleDocument(index).query, documentIds[index - 1]!));
  }

  const storageKilobytes = Number.parseInt(
    (await runtime.runCommand(["docker", "exec", runtime.containerName, "sh", "-c", "du -sk /app/data | cut -f1"])).trim(),
    10,
  );
  if (!Number.isFinite(storageKilobytes)) throw new Error("Could not measure container storage.");

  const restartStarted = runtime.now();
  await runtime.runCommand(["docker", "restart", runtime.containerName]);
  runtime.baseUrl = await runtime.resolveBaseUrl();
  await runtime.waitForHealth(runtime.baseUrl);
  const healthReadyMs = runtime.now() - restartStarted;
  const restartSearchMs = await runSearch(runtime, generateScaleDocument(1).query, documentIds[0]!);
  peakRssBytes = Math.max(peakRssBytes, await sampleRss(runtime));

  const report: ScaleReport = {
    schemaVersion: 1,
    documents: arguments_.documents,
    environment: {
      capturedAtUtc: runtime.capturedAtUtc(),
      dockerVersion,
      hostArchitecture: runtime.hostArchitecture,
      cpuModel: runtime.cpuModel,
      cpuCount: runtime.cpuCount,
      totalMemoryBytes: runtime.totalMemoryBytes,
      imageReference,
      imageDigest,
      commit,
    },
    ingestion: {
      totalMs: rounded(ingestionTotalMs),
      perDocumentMs: rounded(ingestionTotalMs / arguments_.documents),
    },
    resources: {
      peakRssBytes,
      storageBytes: storageKilobytes * 1024,
    },
    search: {
      sampleSize: arguments_.documents,
      coldMs: { p50: rounded(percentile(coldLatencies, 0.5)), p95: rounded(percentile(coldLatencies, 0.95)) },
      warmMs: { p50: rounded(percentile(warmLatencies, 0.5)), p95: rounded(percentile(warmLatencies, 0.95)) },
    },
    restart: {
      healthReadyMs: rounded(healthReadyMs),
      searchReadyMs: rounded(healthReadyMs + restartSearchMs),
    },
  };
  await writeFile(arguments_.outputPath, serializeScaleReport(report), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return report;
}

if (import.meta.main) {
  try {
    const arguments_ = parseScaleArguments(Bun.argv.slice(2));
    const report = await runScale(arguments_);
    console.log(JSON.stringify({ ok: true, documents: report.documents, output: arguments_.outputPath }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Scale measurement failed.");
    process.exitCode = 1;
  }
}
