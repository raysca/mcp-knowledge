import type { CollectionService, DocumentService } from "@mcp-knowledge/core";
import type { AppEnv } from "../config/env.ts";
import { clampLimit, errorResponse, json, requestIdOf } from "./respond.ts";

export type AppServices = {
  env: AppEnv;
  documents: DocumentService;
  collections: CollectionService;
};

function documentJson(doc: Awaited<ReturnType<DocumentService["get"]>>) {
  return {
    id: doc.id,
    collectionId: doc.collectionId ?? null,
    currentRevisionId: doc.currentRevisionId ?? null,
    title: doc.title ?? null,
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    extension: doc.extension ?? null,
    sizeBytes: doc.sizeBytes,
    sha256: doc.sha256,
    status: doc.status,
    metadata: doc.metadata,
    latestError: doc.latestError ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function handleRequest(req: Request, svc: AppServices): Promise<Response> {
  const requestId = requestIdOf(req);
  const url = new URL(req.url);
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      return json({ ok: true }, 200, requestId);
    }

    if (url.pathname === "/api/v1/collections" && req.method === "GET") {
      const items = await svc.collections.list();
      return json({ items }, 200, requestId);
    }
    if (url.pathname === "/api/v1/collections" && req.method === "POST") {
      const body = (await req.json()) as { name?: string; description?: string };
      const col = await svc.collections.create({
        name: body.name ?? "",
        description: body.description,
      });
      return json(col, 201, requestId);
    }
    const colMatch = url.pathname.match(/^\/api\/v1\/collections\/([^/]+)$/);
    if (colMatch) {
      const id = decodeURIComponent(colMatch[1]!);
      if (req.method === "GET") return json(await svc.collections.get(id), 200, requestId);
      if (req.method === "PATCH") {
        const body = (await req.json()) as { name?: string; description?: string | null };
        return json(await svc.collections.update(id, body), 200, requestId);
      }
      if (req.method === "DELETE") {
        await svc.collections.delete(id);
        return json({ ok: true }, 200, requestId);
      }
    }

    if (url.pathname === "/api/v1/documents" && req.method === "GET") {
      const limit = clampLimit(url.searchParams.get("limit"), svc.env.MAX_LIST_LIMIT, 50);
      const result = await svc.documents.list({
        collectionId: url.searchParams.get("collectionId") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit,
      });
      return json(
        { items: result.items.map(documentJson), nextCursor: result.nextCursor ?? null },
        200,
        requestId,
      );
    }

    if (url.pathname === "/api/v1/documents" && req.method === "POST") {
      // ponytail: Content-Length bounds the whole multipart body (boundary + headers + file),
      // not just the file bytes MAX_UPLOAD_BYTES is checked against downstream — so this can
      // only reject bodies that are already way past any reasonable multipart overhead, not
      // enforce the limit precisely (that stays DocumentService's job, post-parse). It's also
      // client-declared and spoofable via chunked encoding. Good enough to stop a multi-GB
      // body from being buffered at all; a real streaming multipart cap is the full fix, add
      // it if a public server-profile deployment makes the spoofed case a real threat.
      const MULTIPART_OVERHEAD_SLACK = 64 * 1024;
      const declaredLength = Number(req.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > svc.env.MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_SLACK
      ) {
        return json(
          { error: { code: "PAYLOAD_TOO_LARGE", message: "Upload exceeds MAX_UPLOAD_BYTES.", requestId } },
          413,
          requestId,
        );
      }
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return json(
          { error: { code: "INVALID_UPLOAD", message: "Missing file field.", requestId } },
          400,
          requestId,
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let metadata: Record<string, unknown> = {};
      const rawMeta = form.get("metadata");
      if (typeof rawMeta === "string" && rawMeta.length > 0) {
        metadata = JSON.parse(rawMeta) as Record<string, unknown>;
      }
      const collectionId = form.get("collectionId");
      const result = await svc.documents.upload({
        filename: file.name,
        bytes,
        collectionId: typeof collectionId === "string" ? collectionId : undefined,
        metadata,
      });
      return json(
        {
          id: result.document.id,
          status: result.document.status,
          revision: result.revision,
          duplicate: result.duplicate,
        },
        result.status,
        requestId,
      );
    }

    const fileMatch = url.pathname.match(/^\/api\/v1\/documents\/([^/]+)\/file$/);
    if (fileMatch && req.method === "GET") {
      const id = decodeURIComponent(fileMatch[1]!);
      const file = await svc.documents.file(id);
      return new Response(file.blob, {
        headers: {
          "content-type": file.mimeType,
          "content-disposition": `attachment; filename="${file.filename}"`,
          "x-request-id": requestId,
        },
      });
    }

    const docMatch = url.pathname.match(/^\/api\/v1\/documents\/([^/]+)$/);
    if (docMatch) {
      const id = decodeURIComponent(docMatch[1]!);
      if (req.method === "GET") {
        return json(documentJson(await svc.documents.get(id)), 200, requestId);
      }
      if (req.method === "DELETE") {
        await svc.documents.delete(id);
        return json({ ok: true }, 200, requestId);
      }
    }

    return json(
      { error: { code: "NOT_FOUND", message: "Not found.", requestId } },
      404,
      requestId,
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
