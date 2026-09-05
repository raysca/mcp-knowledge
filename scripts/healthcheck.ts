export type HealthCheckInput = {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  url?: string;
};

export async function checkHealth(input: HealthCheckInput = {}): Promise<boolean> {
  const url = input.url ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  const request = input.fetch ?? globalThis.fetch;

  try {
    const response = await request(`${url}/health`);
    const body: unknown = await response.json();
    return response.status === 200 && typeof body === "object" && body !== null && "ok" in body && body.ok === true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  process.exitCode = (await checkHealth()) ? 0 : 1;
}
