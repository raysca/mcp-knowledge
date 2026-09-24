import {
  AppError,
  CATALOG_FIELDS,
  type CollectionService,
  type CollapsedSearchHit,
  type DocumentService,
  type DocumentCatalogService,
  type SearchHit,
  type SearchService,
} from "@mcp-knowledge/core";
import { boundedInteger } from "./arguments.ts";

type McpServices = {
  env: {
    DEFAULT_SEARCH_LIMIT: number;
    MAX_SEARCH_LIMIT_MCP: number;
    MAX_MCP_DOCUMENT_CHARS: number;
    MAX_LIST_LIMIT: number;
  };
  documents: DocumentService;
  catalog: DocumentCatalogService;
  collections: CollectionService;
  search: SearchService;
};

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const tools = (env: McpServices["env"]) => [
  {
    name: "search_documents",
    description: "Hybrid search over ingested documents.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        collection_ids: { type: "array", items: { type: "string" } },
        document_ids: { type: "array", items: { type: "string" } },
        filters: { type: "object" },
        expand: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["none", "neighbors", "section"] },
            before: { type: "integer", minimum: 0, maximum: 5 },
            after: { type: "integer", minimum: 0, maximum: 5 },
          },
        },
        limit: { type: "integer", minimum: 1, maximum: env.MAX_SEARCH_LIMIT_MCP },
        mode: { type: "string" },
        collapse: { type: "string", enum: ["none", "document"] },
      },
      required: ["query"],
    },
  },
  {
    name: "get_document",
    description: "Get a document page with a complete JSON body. Follow nextBlockCursor for more blocks.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        block_cursor: { type: "string" },
        block_limit: { type: "integer", minimum: 1, maximum: env.MAX_LIST_LIMIT },
        headings: { type: "array", items: { type: "string" } },
      },
      required: ["document_id"],
    },
  },
  {
    name: "get_chunk",
    description: "Get a chunk by id.",
    inputSchema: {
      type: "object",
      properties: {
        chunk_id: { type: "string" },
        before: { type: "integer", minimum: 0, maximum: 5 },
        after: { type: "integer", minimum: 0, maximum: 5 },
      },
      required: ["chunk_id"],
    },
  },
  {
    name: "list_documents",
    description: "List documents in the instance.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: env.MAX_LIST_LIMIT },
        cursor: { type: "string" },
        status: { type: "string" },
        collection_id: { type: "string" },
      },
    },
  },
  {
    name: "list_collections",
    description: "List collections.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_document_catalog",
    description: "List lightweight document metadata (ready by default). Follow nextCursor without if_corpus_version; restart if corpusVersion changes between pages. Use if_corpus_version to check a completed catalog for changes.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: env.MAX_LIST_LIMIT },
        cursor: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["pending", "processing", "ready", "failed", "deleted"], default: "ready" },
        collection_id: { type: "string", minLength: 1 },
        filters: { type: "object" },
        fields: { type: "array", minItems: 1, items: { type: "string", enum: CATALOG_FIELDS } },
        if_corpus_version: { type: "string", pattern: "^generation:(0|[1-9][0-9]*)$", description: "A generation with a nonnegative safe integer (at most 9007199254740991). An equal version returns only corpusVersion and unchanged: true." },
      },
    },
  },
];

function textResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function isCollapsedSearchHit(hit: SearchHit): hit is CollapsedSearchHit {
  return "matchingChunkCount" in hit;
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
  if (msg.method === "tools/list") return rpcResult(id, { tools: tools(svc.env) });
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
      const message = error instanceof AppError
        ? `${error.code}: ${error.message}`
        : error instanceof Error ? error.message : String(error);
      return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
    }
  }
  return rpcError(id, -32601, `Unknown method ${msg.method}`);
}

async function callTool(name: string, args: Record<string, unknown>, svc: McpServices) {
  if (name === "list_document_catalog") {
    return svc.catalog.list({
      collectionId: args.collection_id,
      status: args.status,
      cursor: args.cursor,
      limit: args.limit,
      fields: args.fields,
      filters: args.filters,
      ifCorpusVersion: args.if_corpus_version,
    });
  }
  if (name === "search_documents") {
    const limit = boundedInteger(args.limit, {
      name: "limit",
      defaultValue: Math.min(svc.env.DEFAULT_SEARCH_LIMIT, svc.env.MAX_SEARCH_LIMIT_MCP),
      min: 1,
      max: svc.env.MAX_SEARCH_LIMIT_MCP,
    });
    if (args.collapse !== undefined && args.collapse !== "none" && args.collapse !== "document") {
      throw new AppError("INVALID_TOOL_ARGUMENTS", "collapse must be none or document.", 400);
    }
    const collapse = args.collapse as "none" | "document" | undefined;
    if (args.expand != null && (typeof args.expand !== "object" || Array.isArray(args.expand))) {
      throw new AppError("INVALID_TOOL_ARGUMENTS", "expand must be an object.", 400);
    }
    const requestedExpand = args.expand as Record<string, unknown> | undefined;
    const type = requestedExpand?.type ?? "none";
    if (type !== "none" && type !== "neighbors" && type !== "section") {
      throw new AppError(
        "INVALID_TOOL_ARGUMENTS",
        "expand.type must be none, neighbors, or section.",
        400,
      );
    }
    const before = boundedInteger(requestedExpand?.before, {
      name: "expand.before",
      defaultValue: 2,
      min: 0,
      max: 5,
    });
    const after = boundedInteger(requestedExpand?.after, {
      name: "expand.after",
      defaultValue: 2,
      min: 0,
      max: 5,
    });
    const result = await svc.search.search({
      query: String(args.query ?? ""),
      collectionIds: args.collection_ids as string[] | undefined,
      documentIds: args.document_ids as string[] | undefined,
      filters: args.filters,
      mode: typeof args.mode === "string" ? args.mode : "hybrid",
      collapse,
      limit,
      expand: { type, before, after },
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
      ...(collapse === "document" && isCollapsedSearchHit(h) ? {
        matchingChunkCount: h.matchingChunkCount,
        matchedHeadings: h.matchedHeadings,
        chunkRank: h.ranking.chunkRank,
      } : {}),
      resourceUri: `document://${h.documentId}`,
    }));
  }
  if (name === "get_document") {
    if (args.block_limit === null || args.block_limit === "") {
      throw new AppError("INVALID_TOOL_ARGUMENTS", "block_limit must be a positive integer.", 400);
    }
    const blockLimit = args.block_limit === undefined ? undefined : boundedInteger(args.block_limit, {
      name: "block_limit",
      defaultValue: Math.min(50, svc.env.MAX_LIST_LIMIT),
      min: 1,
      max: svc.env.MAX_LIST_LIMIT,
    });
    if (args.block_cursor !== undefined &&
        (typeof args.block_cursor !== "string" || args.block_cursor.length === 0)) {
      throw new AppError("INVALID_TOOL_ARGUMENTS", "block_cursor must be a non-empty string.", 400);
    }
    if (args.headings !== undefined &&
        (!Array.isArray(args.headings) || args.headings.some((heading) => typeof heading !== "string"))) {
      throw new AppError("INVALID_TOOL_ARGUMENTS", "headings must be an array of strings.", 400);
    }
    const { document, ...page } = await svc.documents.normalizedPage(String(args.document_id), {
      cursor: args.block_cursor as string | undefined,
      blockLimit,
      maxChars: svc.env.MAX_MCP_DOCUMENT_CHARS,
      headings: args.headings as string[] | undefined,
    });
    return {
      ...document,
      ...page,
    };
  }
  if (name === "get_chunk") {
    const before = boundedInteger(args.before, { name: "before", defaultValue: 0, min: 0, max: 5 });
    const after = boundedInteger(args.after, { name: "after", defaultValue: 0, min: 0, max: 5 });
    return svc.documents.chunk(String(args.chunk_id), { before, after });
  }
  if (name === "list_documents") {
    const limit = boundedInteger(args.limit, {
      name: "limit",
      defaultValue: Math.min(50, svc.env.MAX_LIST_LIMIT),
      min: 1,
      max: svc.env.MAX_LIST_LIMIT,
    });
    return svc.documents.list({
      limit,
      cursor: typeof args.cursor === "string" ? args.cursor : undefined,
      status: typeof args.status === "string" ? args.status : undefined,
      collectionId: typeof args.collection_id === "string" ? args.collection_id : undefined,
    });
  }
  if (name === "list_collections") {
    return { items: await svc.collections.list() };
  }
  throw new Error(`Unknown tool ${name}`);
}
