export type ArchiveImportSummary = {
  id: string;
  originalFilename: string;
  state: "queued" | "extracting" | "completed" | "completed_with_errors" | "failed";
  counts: {
    examined: number;
    extracted: number;
    duplicate: number;
    unsupported: number;
    oversized: number;
    failed: number;
  };
  error: string | null;
};

const STATE_LABEL: Record<ArchiveImportSummary["state"], string> = {
  queued: "Queued",
  extracting: "Extracting",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
};

function stateClass(state: ArchiveImportSummary["state"]): string {
  if (state === "completed") return "border-navy/30 bg-navy/10 text-navy";
  if (state === "failed" || state === "completed_with_errors") return "border-stamp/40 bg-stamp/10 text-stamp";
  return "border-amber-400/30 bg-amber-400/10 text-amber-300";
}

export function ArchiveImportsPanel({
  items,
  error,
}: {
  items: ArchiveImportSummary[];
  error: string | null;
}) {
  if (items.length === 0 && !error) return null;
  return (
    <section className="mb-6 rounded-xl border border-rule bg-shelf p-5">
      <h2 className="text-lg font-semibold tracking-tight">
        Archive imports
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate">No archive imports yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="font-mono">{item.originalFilename}</span>
              <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${stateClass(item.state)}`}>
                {STATE_LABEL[item.state]}
              </span>
              <span className="font-mono text-xs text-slate">
                {item.counts.extracted} extracted, {item.counts.failed} failed
              </span>
              {item.state === "failed" && item.error ? (
                <p className="w-full text-sm text-stamp">{item.error}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="mt-3 text-sm text-stamp">{error}</p> : null}
    </section>
  );
}
