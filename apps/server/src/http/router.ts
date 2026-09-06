import { timingSafeEqual } from "node:crypto";
import type {
  ApiKeyService,
  ArchiveImportService,
  CollectionService,
  DocumentService,
  SearchService,
  UrlIngestService,
} from "@mcp-knowledge/core";
import { AppError, extensionOf, type ArchiveImport, type ArchiveImportEntryOutcome } from "@mcp-knowledge/core";
import type { AppEnv } from "../config/env.ts";
import { handleMcp } from "../mcp/handler.ts";
import type { StartupIngestionCoordinator } from "../startup-scan/coordinator.ts";
import { requiredScope, scopeAllows } from "./auth.ts";
import { clampLimit, errorResponse, json, requestIdOf } from "./respond.ts";
import {
  clearSessionCookieHeader,
  loginRateLimited,
  parseCookie,
  sessionCookieHeader,
  SESSION_COOKIE,
  verifySessionCookieValue,
} from "./session.ts";

export type AppServices = {
  env: AppEnv;
  documents: DocumentService;
  archives: ArchiveImportService;
  collections: CollectionService;
  search: SearchService;
  keys: ApiKeyService;
  urls: UrlIngestService;
  startupScan: Pick<StartupIngestionCoordinator, "status">;
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

function archiveImportJson(record: ArchiveImport) {
  const counts: Record<ArchiveImportEntryOutcome | "examined", number> = {
    examined: 0,
    extracted: 0,
    duplicate: 0,
    unsupported: 0,
    oversized: 0,
    failed: 0,
  };
  const documentIds: string[] = [];
  for (const entry of record.entries) {
    counts.examined += 1;
    counts[entry.outcome] += 1;
    if (entry.outcome === "extracted" && entry.documentId) documentIds.push(entry.documentId);
  }
  return {
    id: record.id,
    originalFilename: record.originalFilename,
    collectionId: record.collectionId ?? null,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    counts,
    documentIds,
    error: record.error ?? null,
  };
}

export async function handleRequest(
  req: Request,
  svc: AppServices,
  remoteAddress?: string,
): Promise<Response> {
  const requestId = requestIdOf(req);
  const url = new URL(req.url);
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      return json({ ok: true }, 200, requestId);
    }

    const passphrase = svc.env.DASHBOARD_PASSPHRASE;

    if (url.pathname === "/api/v1/session") {
      if (req.method === "GET") {
        const authed = !passphrase || verifySessionCookieValue(passphrase, parseCookie(req, SESSION_COOKIE));
        return json({ passphraseRequired: Boolean(passphrase), authenticated: authed }, 200, requestId);
      }
      if (req.method === "POST") {
        if (!passphrase) return json({ authenticated: true }, 200, requestId);
        // Rate-limit by remote address, not by the (unauthenticated) request itself - the
        // whole point is to slow down guessing, which means keying on who's guessing.
        if (loginRateLimited(remoteAddress ?? "unknown")) {
          throw new AppError("TOO_MANY_ATTEMPTS", "Too many login attempts. Try again later.", 429);
        }
        const body = (await req.json()) as { passphrase?: string };
        const given = Buffer.from(body.passphrase ?? "", "utf8");
        const want = Buffer.from(passphrase, "utf8");
        const ok = given.length === want.length && timingSafeEqual(given, want);
        if (!ok) throw new AppError("UNAUTHORIZED", "Incorrect passphrase.", 401);
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId,
            "set-cookie": sessionCookieHeader(passphrase, svc.env.APP_PROFILE),
          },
        });
      }
      if (req.method === "DELETE") {
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": clearSessionCookieHeader(svc.env.APP_PROFILE) },
        });
      }
    }

    const need = requiredScope(req.method, url.pathname);
    if (need && passphrase) {
      const hasSession = verifySessionCookieValue(passphrase, parseCookie(req, SESSION_COOKIE));
      if (!hasSession) {
        const header = req.headers.get("authorization");
        const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
        const key = await svc.keys.authenticate(bearer);
        if (!scopeAllows(key.scopes, need)) {
          throw new AppError("FORBIDDEN", "API key lacks required scope.", 403);
        }
      }
    }

    if (url.pathname === "/mcp" && req.method === "POST") {
      const result = await handleMcp(await req.json(), svc);
      if (result === undefined) {
        return new Response(null, { status: 202, headers: { "x-request-id": requestId } });
      }
      return json(result, 200, requestId);
    }

    if (url.pathname === "/api/v1/api-keys" && req.method === "GET") {
      const items = await svc.keys.list();
      return json(
        {
          items: items.map((k) => ({
            id: k.id,
            name: k.name,
            keyPrefix: k.keyPrefix,
            scopes: k.scopes,
            createdAt: k.createdAt.toISOString(),
            lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          })),
        },
        200,
        requestId,
      );
    }
    if (url.pathname === "/api/v1/api-keys" && req.method === "POST") {
      const body = (await req.json()) as { name?: string; scopes?: string[] };
      const created = await svc.keys.create({ name: body.name ?? "", scopes: body.scopes });
      return json(
        {
          id: created.key.id,
          name: created.key.name,
          keyPrefix: created.key.keyPrefix,
          scopes: created.key.scopes,
          secret: created.secret,
          createdAt: created.key.createdAt.toISOString(),
        },
        201,
        requestId,
      );
    }

    if (url.pathname === "/api/v1/documents/purge" && req.method === "POST") {
      const body = (await req.json()) as { confirm?: string };
      if (body.confirm !== "purge") {
        throw new AppError("INVALID_REQUEST", 'Send { "confirm": "purge" }.', 400);
      }
      return json(await svc.documents.purgeCorpus(), 200, requestId);
    }

    if (url.pathname === "/api/v1/documents/from-url" && req.method === "POST") {
      const body = (await req.json()) as {
        url?: string;
        collectionId?: string;
        metadata?: Record<string, unknown>;
      };
      const result = await svc.urls.ingest({
        url: body.url ?? "",
        collectionId: body.collectionId,
        metadata: body.metadata,
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
      const collectionId = form.get("collectionId");
      let metadata: Record<string, unknown> = {};
      const rawMeta = form.get("metadata");
      if (typeof rawMeta === "string" && rawMeta.length > 0) {
        metadata = JSON.parse(rawMeta) as Record<string, unknown>;
      }
      if (extensionOf(file.name) === "zip") {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { archiveId } = await svc.archives.stage({
          filename: file.name,
          bytes,
          collectionId: typeof collectionId === "string" ? collectionId : undefined,
          metadata,
        });
        return json({ archiveId, status: "queued" }, 202, requestId);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
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

    const chunksMatch = url.pathname.match(/^\/api\/v1\/documents\/([^/]+)\/chunks$/);
    if (chunksMatch && req.method === "GET") {
      const id = decodeURIComponent(chunksMatch[1]!);
      const limit = clampLimit(url.searchParams.get("limit"), svc.env.MAX_LIST_LIMIT, 50);
      const result = await svc.documents.chunks(id, {
        limit,
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      return json(result, 200, requestId);
    }

    const chunkMatch = url.pathname.match(/^\/api\/v1\/chunks\/([^/]+)$/);
    if (chunkMatch && req.method === "GET") {
      const id = decodeURIComponent(chunkMatch[1]!);
      const before = Number(url.searchParams.get("before") ?? 0);
      const after = Number(url.searchParams.get("after") ?? 0);
      return json(
        await svc.documents.chunk(id, {
          before: Number.isFinite(before) ? before : 0,
          after: Number.isFinite(after) ? after : 0,
        }),
        200,
        requestId,
      );
    }

    const normalizedMatch = url.pathname.match(/^\/api\/v1\/documents\/([^/]+)\/normalized$/);
    if (normalizedMatch && req.method === "GET") {
      const id = decodeURIComponent(normalizedMatch[1]!);
      return json(await svc.documents.normalized(id), 200, requestId);
    }

    const reindexMatch = url.pathname.match(/^\/api\/v1\/documents\/([^/]+)\/reindex$/);
    if (reindexMatch && req.method === "POST") {
      const id = decodeURIComponent(reindexMatch[1]!);
      const job = await svc.documents.reindex(id);
      return json(job, 202, requestId);
    }

    const archiveMatch = url.pathname.match(/^\/api\/v1\/archives\/([^/]+)$/);
    if (archiveMatch && req.method === "GET") {
      const id = decodeURIComponent(archiveMatch[1]!);
      const record = await svc.archives.get(id);
      return json(archiveImportJson(record), 200, requestId);
    }

    if (url.pathname === "/api/v1/archives" && req.method === "GET") {
      const limit = clampLimit(url.searchParams.get("limit"), svc.env.MAX_LIST_LIMIT, 50);
      const result = await svc.archives.list({
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit,
      });
      return json(
        { items: result.items.map(archiveImportJson), nextCursor: result.nextCursor ?? null },
        200,
        requestId,
      );
    }

    if (url.pathname === "/api/v1/search" && req.method === "POST") {
      const body = (await req.json()) as {
        query?: string;
        collectionIds?: string[];
        documentIds?: string[];
        filters?: unknown;
        mode?: string;
        limit?: number;
        expand?: { type?: string; before?: number; after?: number };
        explain?: boolean;
      };
      const limit = clampLimit(
        body.limit == null ? null : String(body.limit),
        svc.env.MAX_SEARCH_LIMIT_API,
        svc.env.DEFAULT_SEARCH_LIMIT,
      );
      return json(
        await svc.search.search({
          query: body.query ?? "",
          collectionIds: body.collectionIds,
          documentIds: body.documentIds,
          filters: body.filters,
          mode: body.mode,
          limit,
          expand: body.expand,
          explain: body.explain,
        }),
        200,
        requestId,
      );
    }

    if (url.pathname === "/api/v1/search/explain" && req.method === "POST") {
      const body = (await req.json()) as {
        query?: string;
        collectionIds?: string[];
        documentIds?: string[];
        filters?: unknown;
        mode?: string;
        limit?: number;
        expand?: { type?: string; before?: number; after?: number };
      };
      const limit = clampLimit(
        body.limit == null ? null : String(body.limit),
        svc.env.MAX_SEARCH_LIMIT_API,
        svc.env.DEFAULT_SEARCH_LIMIT,
      );
      return json(
        await svc.search.search({
          query: body.query ?? "",
          collectionIds: body.collectionIds,
          documentIds: body.documentIds,
          filters: body.filters,
          mode: body.mode,
          limit,
          expand: body.expand,
          explain: true,
        }),
        200,
        requestId,
      );
    }

    if (url.pathname === "/api/v1/ingest/scan-status" && req.method === "GET") {
      return json(svc.startupScan.status(), 200, requestId);
    }

    if (url.pathname === "/api/v1/jobs" && req.method === "GET") {
      return json({ items: await svc.documents.listJobs() }, 200, requestId);
    }
    const retryMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/retry$/);
    if (retryMatch && req.method === "POST") {
      const id = decodeURIComponent(retryMatch[1]!);
      return json(await svc.documents.retryJob(id), 202, requestId);
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
