import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ScanStatusPanel } from "../../apps/server/src/ui/components/scan-status-panel.tsx";
import type { StartupScanStatus } from "../../apps/server/src/startup-scan/coordinator.ts";

const emptyCounts = () => ({
  discovered: 0,
  examined: 0,
  queued: 0,
  unchanged: 0,
  duplicates: 0,
  unsupported: 0,
  oversized: 0,
  failed: 0,
});

const disabled: StartupScanStatus = {
  state: "disabled",
  startedAt: null,
  completedAt: null,
  currentPath: null,
  counts: emptyCounts(),
  limitReached: false,
  error: null,
  disabledReason: "not_configured",
};

const scanning: StartupScanStatus = {
  state: "scanning",
  startedAt: "2026-08-31T00:00:00.000Z",
  completedAt: null,
  currentPath: null,
  counts: { ...emptyCounts(), discovered: 4, examined: 2, queued: 2 },
  limitReached: false,
  error: null,
  disabledReason: null,
};

const completed: StartupScanStatus = {
  ...scanning,
  state: "completed",
  completedAt: "2026-08-31T00:01:00.000Z",
  currentPath: null,
};

const completedWithErrors: StartupScanStatus = {
  ...completed,
  state: "completed_with_errors",
  counts: { ...completed.counts, failed: 1 },
};

const failed: StartupScanStatus = {
  ...scanning,
  state: "failed",
  completedAt: "2026-08-31T00:01:00.000Z",
  currentPath: null,
  error: "Startup scan could not continue.",
};

describe("ScanStatusPanel", () => {
  test("disabled state", () => {
    const html = renderToStaticMarkup(<ScanStatusPanel status={disabled} error={null} />);
    expect(html).toContain("Startup directory scan");
    expect(html).not.toContain("/Users/");
  });

  test("scanning state shows current path", () => {
    const html = renderToStaticMarkup(
      <ScanStatusPanel status={{ ...scanning, currentPath: "handbook/runbook.pdf" }} error={null} />,
    );
    expect(html).toContain("Startup directory scan");
    expect(html).toContain("handbook/runbook.pdf");
    expect(html).not.toContain("/Users/");
  });

  test("completed state", () => {
    const html = renderToStaticMarkup(<ScanStatusPanel status={completed} error={null} />);
    expect(html).toContain("Startup directory scan");
    expect(html).not.toContain("/Users/");
  });

  test("limit-reached state shows the continuation notice", () => {
    const html = renderToStaticMarkup(
      <ScanStatusPanel status={{ ...completed, limitReached: true }} error={null} />,
    );
    expect(html).toContain("File limit reached; scanning will continue on the next startup.");
  });

  test("completed-with-errors state", () => {
    const html = renderToStaticMarkup(<ScanStatusPanel status={completedWithErrors} error={null} />);
    expect(html).toContain("Startup directory scan");
    expect(html).not.toContain("/Users/");
  });

  test("failed state shows the sanitized error", () => {
    const html = renderToStaticMarkup(<ScanStatusPanel status={failed} error={null} />);
    expect(html).toContain("Startup scan could not continue.");
    expect(html).not.toContain("/Users/");
  });

  test("fetch-error state surfaces the error without clearing status", () => {
    const html = renderToStaticMarkup(
      <ScanStatusPanel status={scanning} error="Could not load scan status." />,
    );
    expect(html).toContain("Could not load scan status.");
    expect(html).not.toContain("/Users/");
  });
});
