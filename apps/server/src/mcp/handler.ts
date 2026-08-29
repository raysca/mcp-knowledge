import type { CollectionService, DocumentService, SearchService } from "@mcp-knowledge/core";

type McpServices = {
  env: {
    DEFAULT_SEARCH_LIMIT: number;
    MAX_SEARCH_LIMIT_MCP: number;
    MAX_MCP_DOCUMENT_CHARS: number;
    MAX_LIST_LIMIT: number;
  };
  documents: DocumentService;
  collections: CollectionService;
  search: SearchService;
};

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const TOOLS = [
  {
    name: "search_documents",
    description: "Hybrid search over ingested documents.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        collection_ids: { type: "array", items: { type: "string" } },
        document_ids: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        mode: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_document",
    description: "Get a document. Body is truncated at MAX_MCP_DOCUMENT_CHARS.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "get_chunk",
    description: "Get a chunk by id.",
    inputSchema: {
      type: "object",
      properties: { chunk_id: { type: "string" } },
      required: ["chunk_id"],
    },
  },
  {
    name: "list_documents",
    description: "List documents in the instance.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "list_collections",
    description: "List collections.",
    inputSchema: { type: "object", properties: {} },
  },
];

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export async function handleMcp(body: unknown, svc: McpServices): Promise<unknown> {
  const msg = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = msg.id ?? null;
  if (msg.method === "initialize") {
    return rpcResult(id, {
      protocolVersion: (msg.params?.protocolVersion as string) ?? "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "mcp-knowledge", version: "0.1.0-local" },
    });
  }
  if (msg.method === "notifications/initialized") return undefined;
  if (msg.method === "tools/list") return rpcResult(id, { tools: TOOLS });
  if (msg.method === "resources/list") {
    return rpcResult(id, {
      resources: [{ uri: "document://{documentId}", name: "Document", mimeType: "application/json" }],
    });
  }
  if (msg.method === "resources/read") {
    const uri = String(msg.params?.uri ?? "");
    const m = uri.match(/^document:\/\/(.+)$/);
    if (!m) return rpcError(id, -32602, "Unknown resource");
    const doc = await svc.documents.get(m[1]!);
    return rpcResult(id, {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(doc) }],
    });
  }
  if (msg.method === "tools/call") {
    const name = String(msg.params?.name ?? "");
    const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await callTool(name, args, svc);
      return rpcResult(id, textResult(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
    }
  }
  return rpcError(id, -32601, `Unknown method ${msg.method}`);
}

async function callTool(name: string, args: Record<string, unknown>, svc: McpServices) {
  if (name === "search_documents") {
    const limit = Math.min(
      Number(args.limit) || svc.env.DEFAULT_SEARCH_LIMIT,
      svc.env.MAX_SEARCH_LIMIT_MCP,
    );
    const result = await svc.search.search({
      query: String(args.query ?? ""),
      collectionIds: args.collection_ids as string[] | undefined,
      documentIds: args.document_ids as string[] | undefined,
      mode: typeof args.mode === "string" ? args.mode : "hybrid",
      limit,
    });
    const hits = "hits" in result ? result.hits : [];
    return hits.map((h) => ({
      chunkId: h.chunkId,
      documentId: h.documentId,
      title: h.title,
      content: h.content,
      headingPath: h.headingPath,
      location: h.location,
      rank: h.ranking.finalRank,
      resourceUri: `document://${h.documentId}`,
    }));
  }
  if (name === "get_document") {
    const doc = await svc.documents.get(String(args.document_id));
    let body = "";
    try {
      const normalized = await svc.documents.normalized(doc.id);
      body = JSON.stringify(normalized);
    } catch {
      body = "";
    }
    const cap = svc.env.MAX_MCP_DOCUMENT_CHARS;
    const truncated = body.length > cap;
    return {
      ...doc,
      body: truncated ? body.slice(0, cap) : body,
      truncated,
    };
  }
  if (name === "get_chunk") {
    return svc.documents.chunk(String(args.chunk_id), {});
  }
  if (name === "list_documents") {
    const limit = Math.min(Number(args.limit) || 50, svc.env.MAX_LIST_LIMIT);
    return svc.documents.list({ limit });
  }
  if (name === "list_collections") {
    return { items: await svc.collections.list() };
  }
  throw new Error(`Unknown tool ${name}`);
}
