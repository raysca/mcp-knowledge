import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { IngestionErrorDetails } from "../lib/ingestion-error.ts";

export function documentIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/documents\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

type NavigationClick = Pick<MouseEvent, "button" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

export function shouldNavigateInApp(_event: NavigationClick): boolean {
  return (
    _event.button === 0 &&
    !_event.altKey &&
    !_event.ctrlKey &&
    !_event.metaKey &&
    !_event.shiftKey
  );
}

export function accumulateChunkPage(
  current: ChunkPageState,
  page: { items: ChunkRow[]; nextCursor?: string },
): ChunkPageState {
  return {
    items: [...current.items, ...page.items],
    nextCursor: page.nextCursor ?? null,
  };
}

/** Aborts `ref`'s previous request (if any) and returns a fresh controller to fetch with. */
function nextRequest(ref: { current: AbortController | null }): AbortController {
  ref.current?.abort();
  const controller = new AbortController();
  ref.current = controller;
  return controller;
}

type DocumentDetail = {
  id: string;
  collectionId: string | null;
  currentRevisionId: string | null;
  title: string | null;
  originalFilename: string;
  mimeType: string;
  extension: string | null;
  sizeBytes: number;
  sha256: string;
  status: string;
  metadata: Record<string, unknown>;
  latestError: string | null;
  createdAt: string;
  updatedAt: string;
};

type ChunkRow = {
  id: string;
  documentId: string;
  revisionId: string;
  sequence: number;
  content: string;
  headingPath: string[];
  location?: Record<string, unknown>;
  tokenCount: number;
  metadata: Record<string, unknown>;
  contentHash: string;
};

type ChunkPageState = { items: ChunkRow[]; nextCursor: string | null };

type ApiError = { error?: { message?: string } };

const EMPTY_CHUNKS: ChunkPageState = { items: [], nextCursor: null };

function isProcessing(status: string): boolean {
  return status === "pending" || status === "processing";
}

export function canReindexDocument(status: string): boolean {
  return !isProcessing(status);
}

function hasFields(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border-t border-rule/70 py-3">
      <dt className="font-mono text-[10px] text-slate">{label}</dt>
      <dd className="mt-1 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

export function DocumentDetailPage({
  documentId,
  onBack,
}: {
  documentId: string;
  onBack: () => void;
}) {
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [chunks, setChunks] = useState<ChunkPageState>(EMPTY_CHUNKS);
  const [loadingDocument, setLoadingDocument] = useState(true);
  const [loadingChunks, setLoadingChunks] = useState(false);
  const [action, setAction] = useState<"reindex" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chunkError, setChunkError] = useState<string | null>(null);
  const documentRequest = useRef<AbortController | null>(null);
  const chunkRequest = useRef<AbortController | null>(null);

  const loadDocument = useCallback(async () => {
    const { signal } = nextRequest(documentRequest);
    try {
      const res = await fetch(`/api/v1/documents/${encodeURIComponent(documentId)}`, { signal });
      const data = (await res.json()) as DocumentDetail & ApiError;
      if (!res.ok) {
        setError(data.error?.message ?? "Could not load this document.");
        return;
      }
      setDocument(data);
      setError(null);
    } catch {
      if (!signal.aborted) setError("Could not load this document.");
    } finally {
      if (!signal.aborted) setLoadingDocument(false);
    }
  }, [documentId]);

  useEffect(() => {
    setDocument(null);
    setChunks(EMPTY_CHUNKS);
    setLoadingDocument(true);
    setLoadingChunks(false);
    setError(null);
    setChunkError(null);
    void loadDocument();
    return () => documentRequest.current?.abort();
  }, [loadDocument]);

  useEffect(() => {
    if (!document || !isProcessing(document.status)) return;
    const timer = setInterval(() => void loadDocument(), 2_000);
    return () => clearInterval(timer);
  }, [document, loadDocument]);

  useEffect(() => {
    if (document?.status !== "ready") return;
    const { signal } = nextRequest(chunkRequest);
    setLoadingChunks(true);
    setChunkError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/v1/documents/${encodeURIComponent(documentId)}/chunks?limit=50`,
          { signal },
        );
        const data = (await res.json()) as { items?: ChunkRow[]; nextCursor?: string } & ApiError;
        if (!res.ok) {
          setChunkError(data.error?.message ?? "Could not load chunks.");
          return;
        }
        setChunks({ items: data.items ?? [], nextCursor: data.nextCursor ?? null });
      } catch {
        if (!signal.aborted) setChunkError("Could not load chunks.");
      } finally {
        if (!signal.aborted) setLoadingChunks(false);
      }
    })();
    return () => chunkRequest.current?.abort();
  }, [document?.currentRevisionId, document?.status, documentId]);

  async function loadMore() {
    if (!chunks.nextCursor || loadingChunks) return;
    const { signal } = nextRequest(chunkRequest);
    setLoadingChunks(true);
    setChunkError(null);
    try {
      const params = new URLSearchParams({ limit: "50", cursor: chunks.nextCursor });
      const res = await fetch(
        `/api/v1/documents/${encodeURIComponent(documentId)}/chunks?${params}`,
        { signal },
      );
      const data = (await res.json()) as { items?: ChunkRow[]; nextCursor?: string } & ApiError;
      if (!res.ok) {
        setChunkError(data.error?.message ?? "Could not load more chunks.");
        return;
      }
      setChunks((current) =>
        accumulateChunkPage(current, {
          items: data.items ?? [],
          nextCursor: data.nextCursor,
        }),
      );
    } catch {
      if (!signal.aborted) setChunkError("Could not load more chunks.");
    } finally {
      if (!signal.aborted) setLoadingChunks(false);
    }
  }

  async function reindex() {
    documentRequest.current?.abort();
    chunkRequest.current?.abort();
    setLoadingChunks(false);
    setAction("reindex");
    setError(null);
    try {
      const res = await fetch(`/api/v1/documents/${encodeURIComponent(documentId)}/reindex`, {
        method: "POST",
      });
      const data = (await res.json()) as ApiError;
      if (!res.ok) {
        setError(data.error?.message ?? "Could not reindex this document.");
        return;
      }
      setChunks(EMPTY_CHUNKS);
      setDocument((current) =>
        current ? { ...current, status: "processing", latestError: null } : current,
      );
    } catch {
      setError("Could not reindex this document.");
    } finally {
      setAction(null);
    }
  }

  async function deleteDocument() {
    if (!confirm(`Delete ${document?.originalFilename ?? "this document"}?`)) return;
    documentRequest.current?.abort();
    chunkRequest.current?.abort();
    setLoadingChunks(false);
    setAction("delete");
    setError(null);
    try {
      const res = await fetch(`/api/v1/documents/${encodeURIComponent(documentId)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as ApiError;
      if (!res.ok) {
        setError(data.error?.message ?? "Could not delete this document.");
        return;
      }
      onBack();
    } catch {
      setError("Could not delete this document.");
    } finally {
      setAction(null);
    }
  }

  if (loadingDocument) {
    return (
      <section>
        <BackButton onBack={onBack} />
        <p className="rounded-xl border border-rule bg-shelf py-16 text-center text-slate">Loading document…</p>
      </section>
    );
  }

  if (!document) {
    return (
      <section>
        <BackButton onBack={onBack} />
        <p className="rounded-xl border border-stamp/40 bg-stamp/5 px-4 py-3 text-sm text-stamp">
          {error ?? "Document not found."}
        </p>
      </section>
    );
  }

  const title = document.title?.trim() || document.originalFilename;

  return (
    <section>
      <BackButton onBack={onBack} />

      <header className="rounded-xl border border-rule bg-shelf p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className={document.status === "ready" ? "rounded-md border border-navy/30 bg-navy/10 px-2 py-0.5 font-mono text-[10px] text-navy" : document.status === "failed" ? "rounded-md border border-stamp/40 bg-stamp/10 px-2 py-0.5 font-mono text-[10px] text-stamp" : "rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] text-amber-300"}>
                {document.status}
              </span>
              <span className="font-mono text-[11px] text-slate">{document.mimeType}</span>
            </div>
            <h1 className="break-words font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">{title}</h1>
            {title !== document.originalFilename ? (
              <p className="mt-1 text-sm text-slate">{document.originalFilename}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              className="inline-flex h-9 items-center justify-center rounded-lg border border-rule bg-[#0e1116] px-3 text-sm font-medium text-ink transition-colors hover:border-[#38404c] hover:bg-[#191d24] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
              href={`/api/v1/documents/${encodeURIComponent(documentId)}/file`}
            >
              Download
            </a>
            <Button
              variant="outline"
              disabled={action !== null || !canReindexDocument(document.status)}
              onClick={() => void reindex()}
            >
              {action === "reindex" ? "Reindexing…" : "Reindex"}
            </Button>
            <Button variant="ghost" disabled={action !== null} onClick={() => void deleteDocument()}>
              {action === "delete" ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
        {error ? <p className="mt-4 text-sm text-stamp">{error}</p> : null}
        {document.latestError ? <IngestionErrorDetails value={document.latestError} /> : null}
      </header>

      <dl className="mt-6 grid gap-x-6 rounded-xl border border-rule bg-shelf px-5 sm:grid-cols-2 lg:grid-cols-4">
        <Definition label="Document ID"><span className="font-mono text-xs">{document.id}</span></Definition>
        <Definition label="Revision ID"><span className="font-mono text-xs">{document.currentRevisionId ?? "—"}</span></Definition>
        <Definition label="Size">{document.sizeBytes.toLocaleString()} bytes</Definition>
        <Definition label="Extension">{document.extension ?? "—"}</Definition>
        <Definition label="Collection"><span className="font-mono text-xs">{document.collectionId ?? "Unfiled"}</span></Definition>
        <Definition label="Created">{formatDate(document.createdAt)}</Definition>
        <Definition label="Updated">{formatDate(document.updatedAt)}</Definition>
        <Definition label="SHA-256"><span className="font-mono text-[11px]">{document.sha256}</span></Definition>
      </dl>

      {hasFields(document.metadata) ? (
        <details className="mt-6 rounded-xl border border-rule bg-shelf px-5 py-4">
          <summary className="cursor-pointer font-mono text-[10px] text-slate">
            Document metadata
          </summary>
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-ink">
            {JSON.stringify(document.metadata, null, 2)}
          </pre>
        </details>
      ) : null}

      <div className="mt-10 flex items-end justify-between pb-3">
        <div>
          <p className="font-mono text-[10px] text-navy">Current revision</p>
          <h2 className="font-display text-2xl font-semibold tracking-tight">Chunks</h2>
        </div>
        <p className="font-mono text-[11px] text-slate">{chunks.items.length} loaded</p>
      </div>

      {isProcessing(document.status) ? (
        <p className="rounded-xl border border-rule bg-shelf py-12 text-center text-slate">
          Chunks will appear when processing finishes.
        </p>
      ) : document.status === "failed" ? (
        <p className="rounded-xl border border-rule bg-shelf py-12 text-center text-slate">
          This document has no browsable chunks because ingestion failed.
        </p>
      ) : loadingChunks && chunks.items.length === 0 ? (
        <p className="rounded-xl border border-rule bg-shelf py-12 text-center text-slate">Loading chunks…</p>
      ) : chunkError && chunks.items.length === 0 ? (
        <p className="rounded-xl border border-stamp/40 bg-stamp/5 py-12 text-center text-stamp">{chunkError}</p>
      ) : chunks.items.length === 0 ? (
        <p className="rounded-xl border border-rule bg-shelf py-12 text-center text-slate">
          This ready document contains no chunks.
        </p>
      ) : (
        <div>
          {chunks.items.map((chunk) => (
            <article
              key={chunk.id}
              className="mb-3 grid overflow-hidden rounded-xl border border-rule bg-shelf sm:grid-cols-[5rem_minmax(0,1fr)]"
            >
              <div className="border-b border-rule bg-[#0e1116] p-4 sm:border-b-0 sm:border-r">
                <span className="font-mono text-xl text-navy">
                  {String(chunk.sequence + 1).padStart(3, "0")}
                </span>
                <div className="mt-1 font-mono text-[10px] text-slate">
                  {chunk.tokenCount} tokens
                </div>
              </div>
              <div className="min-w-0 p-5">
                <p className="mb-3 font-mono text-[11px] text-navy">
                  {chunk.headingPath.length > 0 ? chunk.headingPath.join(" / ") : "Unheaded"}
                </p>
                <div className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[15px] leading-7 text-ink">{chunk.content}</div>
                <div className="mt-5 grid gap-2 border-t border-rule pt-3 font-mono text-[10px] text-slate lg:grid-cols-2">
                  <span className="break-all">{chunk.id}</span>
                  <span className="break-all lg:text-right">hash {chunk.contentHash}</span>
                </div>
                {hasFields(chunk.location) || hasFields(chunk.metadata) ? (
                  <div className="mt-3 grid gap-3 text-xs text-slate lg:grid-cols-2">
                    {hasFields(chunk.location) ? (
                      <div>
                        <span className="font-mono text-[10px]">Source</span>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                          {JSON.stringify(chunk.location, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {hasFields(chunk.metadata) ? (
                      <div>
                        <span className="font-mono text-[10px]">Metadata</span>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                          {JSON.stringify(chunk.metadata, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {chunkError && chunks.items.length > 0 ? <p className="mt-4 text-sm text-stamp">{chunkError}</p> : null}
      {chunks.nextCursor ? (
        <div className="flex justify-center py-6">
          <Button variant="outline" disabled={loadingChunks} onClick={() => void loadMore()}>
            {loadingChunks ? "Loading…" : "Load more chunks"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      className="mb-5 inline-flex font-mono text-[11px] text-navy underline decoration-navy/40 underline-offset-4 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
      onClick={onBack}
    >
      ← All documents
    </button>
  );
}
