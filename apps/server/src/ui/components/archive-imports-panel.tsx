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

export function ArchiveImportsPanel({
  items,
  error,
}: {
  items: ArchiveImportSummary[];
  error: string | null;
}) {
  if (items.length === 0 && !error) return null;
  return (
    <section className="mb-6 border border-rule bg-shelf/40 p-4">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-navy">
        Archive imports
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate">No archive imports yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="font-mono">{item.originalFilename}</span>
              <span className="border border-rule px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-slate">
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
