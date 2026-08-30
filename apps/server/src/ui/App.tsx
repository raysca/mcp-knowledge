import { useCallback, useEffect, useState } from "react";
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
import { PlaygroundPage } from "./pages/playground.tsx";

type Page = "documents" | "collections" | "jobs" | "playground";

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
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-xs border border-rule bg-shelf/40 p-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-navy">Local archive</p>
        <h1 className="mb-4 font-display text-2xl">Enter passphrase</h1>
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
  const path =
    location.pathname === "/collections"
      ? "collections"
      : location.pathname === "/jobs"
        ? "jobs"
        : location.pathname === "/playground"
          ? "playground"
          : "documents";
  const [page, setPage] = useState<Page>(path);

  function go(next: Page) {
    history.pushState(
      {},
      "",
      next === "collections"
        ? "/collections"
        : next === "jobs"
          ? "/jobs"
          : next === "playground"
            ? "/playground"
            : "/",
    );
    setPage(next);
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule bg-shelf/60">
        <div className="mx-auto flex max-w-5xl items-end justify-between gap-6 px-4 pt-8">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-navy">Local archive</p>
            <h1 className="font-display text-4xl leading-none">Knowledge</h1>
          </div>
          <nav className="flex gap-1" aria-label="Primary">
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
      <main className="mx-auto max-w-5xl px-4 py-8">
        {page === "documents" ? (
          <DocumentsPage />
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
          ? "rounded-t-sm border border-b-0 border-rule bg-paper px-4 py-2 text-sm"
          : "rounded-t-sm border border-transparent px-4 py-2 text-sm text-slate hover:text-ink"
      }
    >
      {children}
    </button>
  );
}

function DocumentsPage() {
  const [items, setItems] = useState<DocumentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-slate">
          Files move from processing to ready after parse and chunk. Failures show on Jobs.
        </p>
        <label className="inline-flex cursor-pointer items-center">
          <input
            type="file"
            className="sr-only"
            disabled={busy}
            onChange={(e) => void onUpload(e.target.files?.[0])}
          />
          <Button type="button" disabled={busy} onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement)?.click()}>
            {busy ? "Uploading…" : "Upload file"}
          </Button>
        </label>
      </div>
      {error ? <p className="mb-3 text-sm text-stamp">{error}</p> : null}
      {items.length === 0 ? (
        <p className="border border-dashed border-rule px-4 py-12 text-center text-slate">No documents yet. Upload a file to start the shelf.</p>
      ) : (
        <Table>
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
                  <div className="font-medium">{doc.originalFilename}</div>
                  <div className="font-mono text-[11px] text-slate">{doc.id}</div>
                </TableCell>
                <TableCell>
                  <span className="inline-block border border-stamp px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-stamp">
                    {doc.status}
                  </span>
                  {doc.latestError ? <div className="mt-1 max-w-xs text-xs text-stamp">{doc.latestError}</div> : null}
                </TableCell>
                <TableCell className="font-mono text-xs">{doc.sizeBytes} B</TableCell>
                <TableCell className="text-right">
                  <a className="mr-3 text-sm text-navy underline" href={`/api/v1/documents/${doc.id}/file`}>
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
      <div className="mb-4 flex items-center justify-between">
        <p className="text-slate">Group documents. Delete is blocked while a collection still holds files.</p>
        <Button onClick={() => setOpen(true)}>New collection</Button>
      </div>
      {error ? <p className="mb-3 text-sm text-stamp">{error}</p> : null}
      {items.length === 0 ? (
        <p className="border border-dashed border-rule px-4 py-12 text-center text-slate">No collections yet.</p>
      ) : (
        <Table>
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

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [reload]);

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
      <p className="mb-4 text-slate">Queued, running, and failed ingestion jobs. Retry a failed job to re-parse the same revision.</p>
      {error ? <p className="mb-3 text-sm text-stamp">{error}</p> : null}
      {items.length === 0 ? (
        <p className="border border-dashed border-rule px-4 py-12 text-center text-slate">No jobs yet.</p>
      ) : (
        <Table>
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
                  {job.error ? <div className="mt-1 text-xs text-stamp">{job.error}</div> : null}
                </TableCell>
                <TableCell className="font-mono text-[11px] uppercase">{job.status}</TableCell>
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
