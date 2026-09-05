import { waitForDocument, waitForHealth } from "./http.ts";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const apiKey = process.env.MCP_API_KEY;
const authorizationHeaders: HeadersInit = apiKey ? { authorization: `Bearer ${apiKey}` } : {};

type UploadResult = { id: string; status: string; duplicate: boolean };
type SearchHit = { documentId?: string; ranking?: { finalRank?: number } };

export function smokeFailureMessage(_error: unknown) {
  return "Smoke check failed.";
}

function endpoint(pathname: string) {
  return new URL(pathname, baseUrl).toString();
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function checkedFetch(pathname: string, init?: RequestInit) {
  const requestHeaders = new Headers(authorizationHeaders);
  new Headers(init?.headers).forEach((value, key) => requestHeaders.set(key, value));
  const response = await fetch(endpoint(pathname), {
    ...init,
    headers: requestHeaders,
  });
  requireCondition(response.ok, `Request failed for ${new URL(response.url).pathname} (${response.status})`);
  return response;
}

async function upload(filename: string, bytes: BlobPart, type?: string): Promise<UploadResult> {
  const form = new FormData();
  form.set("file", new File([bytes], filename, type ? { type } : undefined));
  const response = await fetch(endpoint("/api/v1/documents"), {
    method: "POST",
    headers: authorizationHeaders,
    body: form,
  });
  requireCondition(
    response.status === 200 || response.status === 202,
    `Upload failed for /api/v1/documents (${response.status})`,
  );
  const result = (await response.json()) as UploadResult;
  requireCondition(typeof result.id === "string" && result.id.length > 0, "Upload returned no document ID");
  return result;
}

async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await checkedFetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export async function runSmoke() {
  await waitForHealth({ baseUrl });

  const markdown = "# Release smoke\n\nThe release-sentinel-4829 verifies local hybrid retrieval.\n";
  const text = "Release smoke plain text: document provenance must survive retrieval.\n";
  const html = "<article><h1>Release smoke HTML</h1><p>Hybrid ranking is available locally.</p></article>";
  const pdf = await Bun.file(new URL("../fixtures/release-smoke.pdf", import.meta.url)).arrayBuffer();
  const docx = await Bun.file(new URL("../fixtures/hello.docx", import.meta.url)).arrayBuffer();

  const uploads = await Promise.all([
    upload("release-smoke.md", markdown, "text/markdown"),
    upload("release-smoke.txt", text, "text/plain"),
    upload("release-smoke.html", html, "text/html"),
    upload("release-smoke.pdf", pdf, "application/pdf"),
    upload("release-smoke.docx", docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
  ]);
  const documents = await Promise.all(
    uploads.map(({ id }) => waitForDocument(id, { baseUrl, requestInit: { headers: authorizationHeaders } })),
  );
  requireCondition(documents.every((document) => document.status === "ready"), "Uploaded documents did not become ready");

  const duplicate = await upload("release-smoke-copy.md", markdown, "text/markdown");
  requireCondition(duplicate.duplicate === true && duplicate.id === uploads[0]!.id, "Duplicate upload returned a different ID");

  const hybridResponse = await checkedFetch("/api/v1/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "release-sentinel-4829", mode: "hybrid", limit: 5 }),
  });
  const hybrid = (await hybridResponse.json()) as { hits?: SearchHit[] };
  const hybridHit = hybrid.hits?.[0];
  requireCondition(
    hybridHit?.documentId === uploads[0]!.id && typeof hybridHit.ranking?.finalRank === "number",
    "Hybrid search did not return ranked document provenance",
  );

  const explainResponse = await checkedFetch("/api/v1/search/explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "release-sentinel-4829", mode: "hybrid", limit: 5 }),
  });
  const explained = (await explainResponse.json()) as {
    hits?: SearchHit[];
    timings?: { totalMs?: number };
  };
  requireCondition(
    explained.hits?.[0]?.documentId === uploads[0]!.id &&
      typeof explained.hits?.[0]?.ranking?.finalRank === "number" &&
      typeof explained.timings?.totalMs === "number",
    "Explain search did not return provenance and timings",
  );

  const initialized = await rpc("initialize", { protocolVersion: "2024-11-05" });
  requireCondition(initialized.result?.serverInfo !== undefined, "MCP initialize failed");
  const listed = await rpc("tools/list");
  const tools = (listed.result?.tools ?? []) as Array<{ name?: string }>;
  requireCondition(tools.some((tool) => tool.name === "search_documents"), "MCP tools/list omitted search_documents");
  const searched = await rpc("tools/call", {
    name: "search_documents",
    arguments: { query: "release-sentinel-4829", mode: "hybrid", limit: 5 },
  });
  const result = searched.result?.content as Array<{ text?: string }> | undefined;
  const mcpHits = result?.[0]?.text ? (JSON.parse(result[0].text) as Array<{ documentId?: string; resourceUri?: string }>) : [];
  requireCondition(
    mcpHits.some((hit) => hit.documentId === uploads[0]!.id && hit.resourceUri === `document://${uploads[0]!.id}`),
    "MCP search did not return document provenance",
  );

  const original = await checkedFetch(`/api/v1/documents/${encodeURIComponent(uploads[0]!.id)}/file`);
  requireCondition(
    bytesEqual(new Uint8Array(await original.arrayBuffer()), new TextEncoder().encode(markdown)),
    "Original download was not byte-identical",
  );

  console.log(JSON.stringify({ ok: true, readyDocuments: documents.length }));
}

if (import.meta.main) {
  await runSmoke().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: smokeFailureMessage(error) }));
    process.exitCode = 1;
  });
}
