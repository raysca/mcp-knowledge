import type { StartupScanStatus } from "../../startup-scan/coordinator.ts";

const STATE_LABEL: Record<StartupScanStatus["state"], string> = {
  disabled: "Not running",
  scanning: "Scanning",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
};

const DISABLED_REASON_LABEL: Record<
  NonNullable<StartupScanStatus["disabledReason"]>,
  string
> = {
  not_configured: "No startup ingest directory is configured.",
  unsupported_profile: "Startup directory ingestion requires the local profile.",
  unsupported_role: "Startup directory ingestion requires the all role.",
};

const COUNT_LABELS: Array<[keyof StartupScanStatus["counts"], string]> = [
  ["discovered", "Discovered"],
  ["examined", "Examined"],
  ["queued", "Queued"],
  ["unchanged", "Unchanged"],
  ["duplicates", "Duplicates"],
  ["unsupported", "Unsupported"],
  ["oversized", "Oversized"],
  ["failed", "Failed"],
];

export function ScanStatusPanel({
  status,
  error,
}: {
  status: StartupScanStatus;
  error: string | null;
}) {
  return (
    <section className="mb-6 rounded-xl border border-rule bg-shelf p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Startup directory scan
        </h2>
        <span className="rounded-md border border-rule bg-[#0e1116] px-2 py-0.5 font-mono text-[11px] text-slate">
          {STATE_LABEL[status.state]}
        </span>
      </div>

      {status.state === "disabled" && status.disabledReason ? (
        <p className="mt-2 text-sm text-slate">{DISABLED_REASON_LABEL[status.disabledReason]}</p>
      ) : null}

      {status.state === "scanning" && status.currentPath ? (
        <p className="mt-2 font-mono text-xs text-slate">Scanning: {status.currentPath}</p>
      ) : null}

      {status.state !== "disabled" ? (
        <dl className="mt-3 grid grid-cols-4 gap-x-4 gap-y-2 sm:grid-cols-8">
          {COUNT_LABELS.map(([key, label]) => (
            <div key={key}>
              <dt className="font-mono text-[10px] text-slate">{label}</dt>
              <dd className="font-mono text-sm">{status.counts[key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {status.limitReached ? (
        <p className="mt-3 text-sm text-stamp">
          File limit reached; scanning will continue on the next startup.
        </p>
      ) : null}

      {status.state === "failed" && status.error ? (
        <p className="mt-3 text-sm text-stamp">{status.error}</p>
      ) : null}

      {error ? <p className="mt-3 text-sm text-stamp">{error}</p> : null}
    </section>
  );
}
