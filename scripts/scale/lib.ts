import { existsSync } from "node:fs";

export type SupportedDocumentCount = 100 | 500 | 1000;

export type ScaleArguments = {
  documents: SupportedDocumentCount;
  outputPath: string;
};

export type ScaleDocument = {
  filename: string;
  body: string;
  query: string;
  identifier: string;
};

export type LatencyPercentiles = {
  p50: number;
  p95: number;
};

export type ScaleReport = {
  schemaVersion: 1;
  documents: SupportedDocumentCount;
  environment: {
    capturedAtUtc: string;
    dockerVersion: string;
    host: {
      architecture: string;
      cpuModel: string;
      cpuCount: number;
      totalMemoryBytes: number;
    };
    docker: {
      cpuCount: number;
      totalMemoryBytes: number;
    };
    image: {
      reference: string;
      digest: string;
      os: string;
      architecture: string;
      revision: string;
    };
  };
  ingestion: {
    totalMs: number;
    perDocumentMs: number;
  };
  resources: {
    peakRssBytes: number;
    storageBytes: number;
  };
  search: {
    sampleSize: number;
    coldMs: LatencyPercentiles;
    warmMs: LatencyPercentiles;
  };
  restart: {
    healthReadyMs: number;
    searchReadyMs: number;
  };
};

function isSupportedCount(value: number): value is SupportedDocumentCount {
  return value === 100 || value === 500 || value === 1000;
}

export function parseScaleArguments(
  args: string[],
  pathExists: (path: string) => boolean = existsSync,
): ScaleArguments {
  if (args.length !== 4 || args[0] !== "--documents" || args[2] !== "--output") {
    throw new Error("Usage: bun run scale --documents 100|500|1000 --output PATH");
  }
  const documents = Number(args[1]);
  const outputPath = args[3];
  if (!isSupportedCount(documents) || !outputPath) {
    throw new Error("Documents must be exactly 100, 500, or 1000 and output must be non-empty.");
  }
  if (pathExists(outputPath)) {
    throw new Error(`Output path already exists: ${outputPath}`);
  }
  return { documents, outputPath };
}

export function generateScaleDocument(index: number): ScaleDocument {
  if (!Number.isInteger(index) || index < 1 || index > 1000) {
    throw new Error("Scale document index must be an integer from 1 through 1000.");
  }
  const sequence = String(index).padStart(4, "0");
  const identifier = `LOCAL-RAG-${sequence}`;
  return {
    filename: `local-rag-${sequence}.txt`,
    body: `Local RAG scale fixture ${sequence}. Reference identifier ${identifier}. This record exists only for deterministic local retrieval measurement.\n`,
    query: identifier,
    identifier,
  };
}

export function percentile(samples: number[], probability: number): number {
  if (samples.length === 0) throw new Error("Percentile requires at least one sample.");
  if (!(probability > 0 && probability <= 1)) throw new Error("Percentile must be greater than zero and at most one.");
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(probability * sorted.length) - 1]!;
}

export function parseDockerByteSize(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB)$/.exec(value.trim());
  if (!match) throw new Error("Docker returned an unsupported memory measurement.");
  const multipliers = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 } as const;
  return Math.round(Number(match[1]) * multipliers[match[2] as keyof typeof multipliers]);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Scale report ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new Error(`Scale report ${label} has unexpected fields.`);
  }
}

function finiteNonnegative(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Scale report ${label} must be a finite nonnegative number.`);
  }
}

function nonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Scale report ${label} must be a non-empty string.`);
  }
}

export function validateScaleReport(value: unknown): asserts value is ScaleReport {
  const report = record(value, "root");
  exactFields(report, ["schemaVersion", "documents", "environment", "ingestion", "resources", "search", "restart"], "root");
  if (report.schemaVersion !== 1) throw new Error("Scale report schema version must be 1.");
  if (typeof report.documents !== "number" || !isSupportedCount(report.documents)) {
    throw new Error("Scale report document count must be 100, 500, or 1000.");
  }

  const environment = record(report.environment, "environment");
  exactFields(environment, ["capturedAtUtc", "dockerVersion", "host", "docker", "image"], "environment");
  for (const field of ["capturedAtUtc", "dockerVersion"] as const) {
    nonemptyString(environment[field], `environment.${field}`);
  }
  const host = record(environment.host, "environment.host");
  exactFields(host, ["architecture", "cpuModel", "cpuCount", "totalMemoryBytes"], "environment.host");
  nonemptyString(host.architecture, "environment.host.architecture");
  nonemptyString(host.cpuModel, "environment.host.cpuModel");
  finiteNonnegative(host.cpuCount, "environment.host.cpuCount");
  finiteNonnegative(host.totalMemoryBytes, "environment.host.totalMemoryBytes");
  const docker = record(environment.docker, "environment.docker");
  exactFields(docker, ["cpuCount", "totalMemoryBytes"], "environment.docker");
  finiteNonnegative(docker.cpuCount, "environment.docker.cpuCount");
  finiteNonnegative(docker.totalMemoryBytes, "environment.docker.totalMemoryBytes");
  const image = record(environment.image, "environment.image");
  exactFields(image, ["reference", "digest", "os", "architecture", "revision"], "environment.image");
  for (const field of ["reference", "digest", "os", "architecture", "revision"] as const) {
    nonemptyString(image[field], `environment.image.${field}`);
  }

  const ingestion = record(report.ingestion, "ingestion");
  exactFields(ingestion, ["totalMs", "perDocumentMs"], "ingestion");
  finiteNonnegative(ingestion.totalMs, "ingestion.totalMs");
  finiteNonnegative(ingestion.perDocumentMs, "ingestion.perDocumentMs");

  const resources = record(report.resources, "resources");
  exactFields(resources, ["peakRssBytes", "storageBytes"], "resources");
  finiteNonnegative(resources.peakRssBytes, "resources.peakRssBytes");
  finiteNonnegative(resources.storageBytes, "resources.storageBytes");

  const search = record(report.search, "search");
  exactFields(search, ["sampleSize", "coldMs", "warmMs"], "search");
  if (search.sampleSize !== report.documents) throw new Error("Scale report search sample size must match its document count.");
  for (const field of ["coldMs", "warmMs"] as const) {
    const latencies = record(search[field], `search.${field}`);
    exactFields(latencies, ["p50", "p95"], `search.${field}`);
    finiteNonnegative(latencies.p50, `search.${field}.p50`);
    finiteNonnegative(latencies.p95, `search.${field}.p95`);
    if (latencies.p50 > latencies.p95) throw new Error(`Scale report search.${field} p50 cannot exceed p95.`);
  }

  const restart = record(report.restart, "restart");
  exactFields(restart, ["healthReadyMs", "searchReadyMs"], "restart");
  finiteNonnegative(restart.healthReadyMs, "restart.healthReadyMs");
  finiteNonnegative(restart.searchReadyMs, "restart.searchReadyMs");
  if (restart.searchReadyMs < restart.healthReadyMs) {
    throw new Error("Scale report restart search readiness cannot precede health readiness.");
  }
}

export function serializeScaleReport(report: ScaleReport): string {
  validateScaleReport(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}
