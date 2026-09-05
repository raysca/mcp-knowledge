export type ReleaseFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type PollOptions = {
  baseUrl?: string;
  fetch?: ReleaseFetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
};

export type ReleaseDocument = {
  id: string;
  status: string;
  latestError?: string | null;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_DOCUMENT_TIMEOUT_MS = 120_000;

class TerminalDocumentError extends Error {}

function options(input: PollOptions, defaultTimeoutMs: number) {
  return {
    baseUrl: input.baseUrl ?? process.env.BASE_URL ?? DEFAULT_BASE_URL,
    fetch: input.fetch ?? globalThis.fetch,
    sleep: input.sleep ?? Bun.sleep,
    timeoutMs: input.timeoutMs ?? defaultTimeoutMs,
    pollIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    now: input.now ?? Date.now,
  };
}

function endpoint(baseUrl: string, pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

export async function waitForHealth(input: PollOptions = {}): Promise<void> {
  const poll = options(input, DEFAULT_HEALTH_TIMEOUT_MS);
  const url = endpoint(poll.baseUrl, "/health");
  const deadline = poll.now() + poll.timeoutMs;

  do {
    try {
      const response = await poll.fetch(url);
      const body: unknown = await response.json();
      if (response.status === 200 && typeof body === "object" && body !== null && "ok" in body && body.ok === true) {
        return;
      }
    } catch {
      // A starting container may not have accepted connections yet.
    }
    if (poll.now() >= deadline) break;
    await poll.sleep(poll.pollIntervalMs);
  } while (poll.now() < deadline);

  throw new Error(`Timed out waiting for health at ${new URL(url).pathname}`);
}

export async function waitForDocument(id: string, input: PollOptions = {}): Promise<ReleaseDocument> {
  const poll = options(input, DEFAULT_DOCUMENT_TIMEOUT_MS);
  const url = endpoint(poll.baseUrl, `/api/v1/documents/${encodeURIComponent(id)}`);
  const deadline = poll.now() + poll.timeoutMs;

  do {
    try {
      const response = await poll.fetch(url);
      if (response.ok) {
        const document = (await response.json()) as ReleaseDocument;
        if (document.status === "ready") return document;
        if (document.status === "failed") {
          throw new TerminalDocumentError(document.latestError || `Document ${id} failed`);
        }
      }
    } catch (error) {
      // A terminal service failure is actionable and must not be retried; connection and
      // response failures are transient while the service is starting.
      if (error instanceof TerminalDocumentError) throw error;
    }
    if (poll.now() >= deadline) break;
    await poll.sleep(poll.pollIntervalMs);
  } while (poll.now() < deadline);

  throw new Error(`Timed out waiting for document ${id}`);
}
