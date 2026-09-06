import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Dialog } from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
import {
  DocumentDetailPage,
  documentIdFromPath,
  shouldNavigateInApp,
} from "./pages/document-detail.tsx";
import { ScanStatusPanel } from "./components/scan-status-panel.tsx";
import { ArchiveImportsPanel, type ArchiveImportSummary } from "./components/archive-imports-panel.tsx";
import { IngestionErrorDetails } from "./lib/ingestion-error.ts";
import { PlaygroundPage } from "./pages/playground.tsx";
import type { StartupScanStatus } from "../startup-scan/coordinator.ts";

type Page = "documents" | "collections" | "jobs" | "playground";

const PAGE_PATHS: Record<Page, string> = {
  documents: "/",
  collections: "/collections",
  jobs: "/jobs",
  playground: "/playground",
};

type DocumentRow = {
  id: string;
  originalFilename: string;
  status: string;
  sizeBytes: number;
  collectionId: string | null;
  createdAt: string;
  latestError: string | null;
};

type CollectionRow = {
  id: string;
  name: string;
  description?: string | null;
};

type SessionState = "checking" | "open" | "locked" | "unlocked";

function LoginGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>("checking");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    const res = await fetch("/api/v1/session");
    const data = (await res.json()) as { passphraseRequired: boolean; authenticated: boolean };
    setState(!data.passphraseRequired || data.authenticated ? "open" : "locked");
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("Incorrect passphrase.");
      return;
    }
    setState("unlocked");
  }

  if (state === "checking") return null;
  if (state === "open" || state === "unlocked") return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm rounded-xl border border-rule bg-shelf p-7 shadow-2xl">
        <BrandGlyph />
        <p className="mt-5 font-mono text-xs text-navy">MCP Knowledge</p>
        <h1 className="mb-2 mt-2 font-display text-2xl font-semibold tracking-tight">Unlock your knowledge base</h1>
        <p className="mb-5 text-sm text-slate">Enter the dashboard passphrase to continue.</p>
        <Input
          type="password"
          autoFocus
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        {error ? <p className="mt-2 text-sm text-stamp">{error}</p> : null}
        <Button type="submit" className="mt-4 w-full" disabled={busy || !passphrase}>
          {busy ? "Checking…" : "Unlock"}
        </Button>
      </form>
    </div>
  );
}

export function App() {
  return (
    <LoginGate>
      <AppShell />
    </LoginGate>
  );
}

function AppShell() {
  const initialPage = (Object.keys(PAGE_PATHS) as Page[]).find(
    (p) => PAGE_PATHS[p] === location.pathname,
  ) ?? "documents";
  const [page, setPage] = useState<Page>(initialPage);
  const [documentId, setDocumentId] = useState<string | null>(() => documentIdFromPath(location.pathname));

  useEffect(() => {
    function syncFromLocation() {
      const nextDocumentId = documentIdFromPath(location.pathname);
      const nextPage = (Object.keys(PAGE_PATHS) as Page[]).find(
        (candidate) => PAGE_PATHS[candidate] === location.pathname,
      ) ?? "documents";
      setDocumentId(nextDocumentId);
      setPage(nextPage);
    }
    addEventListener("popstate", syncFromLocation);
    return () => removeEventListener("popstate", syncFromLocation);
  }, []);

  function go(next: Page) {
    history.pushState({}, "", PAGE_PATHS[next]);
    setDocumentId(null);
    setPage(next);
  }

  function openDocument(id: string) {
    history.pushState({}, "", `/documents/${encodeURIComponent(id)}`);
    setPage("documents");
    setDocumentId(id);
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-rule bg-paper/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-8 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3 py-1">
            <BrandGlyph />
            <div>
              <p className="font-display text-sm font-semibold leading-tight tracking-tight">MCP Knowledge</p>
              <p className="font-mono text-[10px] text-slate">private retrieval</p>
            </div>
          </div>
          <nav className="order-last mt-2 flex w-full gap-1 overflow-x-auto sm:order-none sm:mt-0 sm:w-auto" aria-label="Primary">
            <Tab active={page === "documents"} onClick={() => go("documents")}>
              Documents
            </Tab>
            <Tab active={page === "collections"} onClick={() => go("collections")}>
              Collections
            </Tab>
            <Tab active={page === "jobs"} onClick={() => go("jobs")}>
              Jobs
            </Tab>
            <Tab active={page === "playground"} onClick={() => go("playground")}>
              Playground
            </Tab>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {documentId ? (
          <DocumentDetailPage documentId={documentId} onBack={() => go("documents")} />
        ) : page === "documents" ? (
          <DocumentsPage onOpenDocument={openDocument} />
        ) : page === "collections" ? (
          <CollectionsPage />
        ) : page === "jobs" ? (
          <JobsPage />
        ) : (
          <PlaygroundPage />
        )}
      </main>
    </div>
  );
}

function BrandGlyph() {
  return (
    <span className="flex h-6 w-6 flex-col justify-center gap-1 rounded-md border border-rule bg-[#191d24] px-1" aria-hidden="true">
      <span className="h-0.5 w-full rounded-full bg-ink" />
      <span className="h-0.5 w-full rounded-full bg-ink" />
      <span className="h-0.5 w-1/2 rounded-full bg-navy" />
    </span>
  );
}

function Tab({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "border-b-2 border-navy px-3 py-2 text-sm font-medium text-ink"
          : "border-b-2 border-transparent px-3 py-2 text-sm text-slate transition-colors hover:text-ink"
      }
    >
      {children}
    </button>
  );
}

function DocumentsPage({ onOpenDocument }: { onOpenDocument: (id: string) => void }) {
  const [items, setItems] = useState<DocumentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const res = await fetch("/api/v1/documents");
    const data = (await res.json()) as { items?: DocumentRow[]; error?: { message: string } };
    if (!res.ok) {
      setError(data.error?.message ?? "Could not load documents.");
      return;
    }
    setItems(data.items ?? []);
    setError(null);
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [reload]);

  async function onUpload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.set("file", file);
    const res = await fetch("/api/v1/documents", { method: "POST", body: form });
    const data = (await res.json()) as { duplicate?: boolean; error?: { message: string } };
    setBusy(false);
    if (!res.ok) {
      setError(data.error?.message ?? "Upload failed.");
      return;
    }
    setError(data.duplicate ? "That file is already in the archive." : null);
    await reload();
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this document?")) return;
    const res = await fetch(`/api/v1/documents/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json()) as { error?: { message: string } };
      setError(data.error?.message ?? "Delete failed.");
      return;
    }
    await reload();
  }

  return (
    <section>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Documents</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate">Upload and inspect the files in your retrieval corpus. Processing failures appear in Jobs.</p>
        </div>
        <div className="inline-flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              void onUpload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            {busy ? "Uploading…" : "Upload file"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || items.length === 0}
            onClick={() => {
              if (!confirm("Delete every document, embedding, and stored file? Collections and API keys stay.")) return;
              void (async () => {
                setBusy(true);
                const res = await fetch("/api/v1/documents/purge", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ confirm: "purge" }),
                });
                const data = (await res.json()) as { error?: { message: string } };
                setBusy(false);
                if (!res.ok) {
                  setError(data.error?.message ?? "Purge failed.");
                  return;
                }
                await reload();
              })();
            }}
          >
            Empty archive
          </Button>
        </div>
      </header>
      {error ? <p className="mb-3 text-sm text-stamp">{error}</p> : null}
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-rule bg-shelf px-4 py-16 text-center text-slate">No documents yet. Upload a file to build your corpus.</p>
      ) : (
        <Table aria-label="Documents">
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Size</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((doc) => (
              <TableRow key={doc.id}>
                <TableCell>
                  <a
                    className="font-medium text-ink underline decoration-rule underline-offset-4 hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
                    href={`/documents/${encodeURIComponent(doc.id)}`}
                    onClick={(event) => {
                      if (!shouldNavigateInApp(event)) return;
                      event.preventDefault();
                      onOpenDocument(doc.id);
                    }}
                  >
                    {doc.originalFilename}
                  </a>
                  <div className="font-mono text-[11px] text-slate">{doc.id}</div>
                </TableCell>
                <TableCell>
                  <span className={doc.status === "ready" ? "inline-block rounded-md border border-navy/30 bg-navy/10 px-2 py-0.5 font-mono text-[11px] text-navy" : doc.status === "failed" ? "inline-block rounded-md border border-stamp/40 bg-stamp/10 px-2 py-0.5 font-mono text-[11px] text-stamp" : "inline-block rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[11px] text-amber-300"}>
                    {doc.status}
                  </span>
                  {doc.latestError ? <IngestionErrorDetails value={doc.latestError} /> : null}
                </TableCell>
                <TableCell className="font-mono text-xs">{doc.sizeBytes} B</TableCell>
                <TableCell className="text-right">
                  <a className="mr-3 text-sm text-navy underline decoration-navy/40 underline-offset-4 hover:text-ink" href={`/api/v1/documents/${doc.id}/file`}>
                    Download
                  </a>
                  <Button variant="ghost" size="sm" onClick={() => void onDelete(doc.id)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function CollectionsPage() {
  const [items, setItems] = useState<CollectionRow[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch("/api/v1/collections");
    const data = (await res.json()) as { items?: CollectionRow[]; error?: { message: string } };
    if (!res.ok) {
      setError(data.error?.message ?? "Could not load collections.");
      return;
    }
    setItems(data.items ?? []);
    setError(null);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onCreate() {
    const res = await fetch("/api/v1/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = (await res.json()) as { error?: { message: string } };
    if (!res.ok) {
      setError(data.error?.message ?? "Could not create collection.");
      return;
    }
    setName("");
    setOpen(false);
    await reload();
  }

  async function onDelete(id: string) {
    const res = await fetch(`/api/v1/collections/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json()) as { error?: { message: string } };
      setError(data.error?.message ?? "Could not delete collection.");
      return;
    }
    await reload();
  }

  return (
    <section>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Collections</h1>
          <p className="mt-2 text-sm text-slate">Group documents into focused retrieval boundaries. Collections must be empty before deletion.</p>
        </div>
        <Button onClick={() => setOpen(true)}>New collection</Button>
      </header>
      {error ? <p className="mb-3 text-sm text-stamp">{error}</p> : null}
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-rule bg-shelf px-4 py-16 text-center text-slate">No collections yet. Create one to organize your corpus.</p>
      ) : (
        <Table aria-label="Collections">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Id</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((col) => (
              <TableRow key={col.id}>
                <TableCell className="font-medium">{col.name}</TableCell>
                <TableCell className="font-mono text-[11px] text-slate">{col.id}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => void onDelete(col.id)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={open} title="New collection" onClose={() => setOpen(false)}>
        <label className="block text-sm">
          Name
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => void onCreate()}>Create</Button>
        </div>
      </Dialog>
    </section>
  );
}

function JobsPage() {
  const [items, setItems] = useState<
    Array<{ id: string; documentId: string; status: string; attempt: number; error?: string | null }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<StartupScanStatus | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [archiveImports, setArchiveImports] = useState<ArchiveImportSummary[]>([]);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch("/api/v1/jobs");
    const data = (await res.json()) as {
      items?: Array<{ id: string; documentId: string; status: string; attempt: number; error?: string | null }>;
      error?: { message: string };
    };
    if (!res.ok) {
      setError(data.error?.message ?? "Could not load jobs.");
      return;
    }
    setItems(data.items ?? []);
    setError(null);
  }, []);

  const reloadScanStatus = useCallback(async () => {
    const res = await fetch("/api/v1/ingest/scan-status");
    const data = (await res.json()) as StartupScanStatus & { error?: { message: string } };
    if (!res.ok) {
      setScanError(data.error?.message ?? "Could not load scan status.");
      return;
    }
    setScanStatus(data);
    setScanError(null);
  }, []);

  const reloadArchiveImports = useCallback(async () => {
    const res = await fetch("/api/v1/archives?limit=5");
    const data = (await res.json()) as { items?: ArchiveImportSummary[]; error?: { message: string } };
    if (!res.ok) {
      setArchiveError(data.error?.message ?? "Could not load archive imports.");
      return;
    }
    setArchiveImports(data.items ?? []);
    setArchiveError(null);
  }, []);

  useEffect(() => {
    const poll = () => void Promise.allSettled([reload(), reloadScanStatus(), reloadArchiveImports()]);
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [reload, reloadScanStatus, reloadArchiveImports]);

  async function onRetry(id: string) {
    const res = await fetch(`/api/v1/jobs/${id}/retry`, { method: "POST" });
    if (!res.ok) {
      const data = (await res.json()) as { error?: { message: string } };
      setError(data.error?.message ?? "Retry failed.");
      return;
    }
    await reload();
  }

  return (
    <section>
      <header className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight">Jobs</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate">Monitor imports and ingestion work. Failed jobs keep their source revision and can be retried.</p>
      </header>
      <ArchiveImportsPanel items={archiveImports} error={archiveError} />
      {scanStatus ? <ScanStatusPanel status={scanStatus} error={scanError} /> : null}
      <h2 className="mb-3 text-lg font-semibold tracking-tight">Ingestion jobs</h2>
      {error ? <p className="mb-3 text-sm text-stamp">{error}</p> : null}
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-rule bg-shelf px-4 py-16 text-center text-slate">No ingestion jobs yet.</p>
      ) : (
        <Table aria-label="Ingestion jobs">
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempt</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <div className="font-mono text-[11px]">{job.id}</div>
                  <div className="font-mono text-[11px] text-slate">{job.documentId}</div>
                  {job.error ? <IngestionErrorDetails value={job.error} /> : null}
                </TableCell>
                <TableCell><span className={job.status === "failed" ? "rounded-md border border-stamp/40 bg-stamp/10 px-2 py-0.5 font-mono text-[11px] text-stamp" : job.status === "completed" ? "rounded-md border border-navy/30 bg-navy/10 px-2 py-0.5 font-mono text-[11px] text-navy" : "rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[11px] text-amber-300"}>{job.status}</span></TableCell>
                <TableCell className="font-mono text-xs">{job.attempt}</TableCell>
                <TableCell className="text-right">
                  {job.status === "failed" ? (
                    <Button variant="outline" size="sm" onClick={() => void onRetry(job.id)}>
                      Retry
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
